// Orchestration: owns live sessions, the per-thread queue, streaming state and approvals.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSession } from "./claude";
import { CodexSession } from "./codex";
import { handoff } from "./handoff";
import { noEvents, type AgentSession, type SessionEvents, type SessionOptions, type Steered } from "./session";
import { TOOLS, type AgentInput, type AgentSendInput, type AgentStatusInput, type AgentTool } from "./prompt";
import { z } from "zod";
import type { Git } from "./git";
import { formatThreadTitleContext, generateThreadTitle, pickTitleModel, resolveThreadTitleLinks, titleAttachments } from "./title";
import type { Store } from "./store";
import type { Surfaces } from "./surfaces";
import { expandVisualize, VISUALIZE_COMMAND } from "./visualize";
import { agentTaskKey, agentTerminal, type AgentTaskRecord } from "./agent-types";
import { prepareAgentWorkspace } from "./agent-workspace";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../shared/protocol";
import type {
  Access,
  ApprovalRequest,
  Attachment,
  Command,
  Effort,
  Event,
  Item,
  Limit,
  ModelOption,
  Provider,
  Question,
  Queued,
  Thread,
  ThreadStatus,
} from "../shared/protocol";

const DELTA_FLUSH_MS = 33;
const IDLE_CLOSE_MS = 15 * 60_000;
const COMMANDS_TTL_MS = 2 * 60_000;
const MAX_RUNNING_AGENTS = 6; // per parent thread
const REPORT_COALESCE_MS = 1500; // sub-agents that finish together are reported together
const REPORT_INLINE_BYTES = 16_000; // beyond this, a report points at agent_status instead
const AGENT_WAIT_MS = 10 * 60_000;
const TOOLS_VERSION = 4;

function createSession(provider: Provider, opts: SessionOptions, events: SessionEvents): AgentSession {
  return provider === "codex" ? new CodexSession(opts, events) : new ClaudeSession(opts, events);
}

interface Live {
  session?: AgentSession;
  stale?: boolean; // options changed that need a fresh process; applied on next send
  status: ThreadStatus;
  queue: Queued[];
  held?: boolean; // Stop (or a restart) paused the queue; the next message the user sends, or Resume, releases it
  stopping?: boolean; // Stop was pressed and the turn is still winding down
  steering?: Promise<void>; // serialize corrections; keep them queued until the provider accepts
  streaming: Map<string, Item>;
  deltas: Map<string, string>;
  flush?: Timer;
  lastActive: number;
  reportTo?: string; // a sub-agent's parent, waiting for this turn's report
  stopped?: boolean;
  preparing?: AbortController;
  preparation?: Promise<void>;
  cancelTimer?: Timer;
  turnError?: string;
  active?: { id: string; messageId: string; task?: string; reports: string[]; question?: Queued["agentQuestion"] };
}

// A sub-agent's piece of work for its parent. The sub-agent is a thread of its own; a task lasts
// from a brief to the turn that answers it, and a follow-up to a finished agent starts a new one.
interface Task extends AgentTaskRecord {
  waiters: Set<() => void>;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve(allow: boolean): void;
}

// Skills that have nothing to do with coding in a project; hidden from the agents and the "/" menu.
const HIDDEN_SKILLS = new Set([
  // Claude (claude.ai skills are listed without their "anthropic-skills:" prefix)
  "docs",
  "docx",
  "google-workspace",
  "pdf",
  "pptx",
  "xlsx",
  "consolidate-memory",
  "explain-usage",
  "setup-claude",
  "cowork-plugin-management:cowork-plugin-customizer",
  "cowork-plugin-management:create-cowork-plugin",
  "update-config",
  "keybindings-help",
  "fewer-permission-prompts",
  "plugin-authoring",
  "loop",
  "schedule",
  "dataviz", // Tack's `show` covers visuals
  "skill-creator",
  "design-sync",
  // Codex
  "documents:documents",
  "pdf:pdf",
  "presentations:Presentations",
  "spreadsheets:Spreadsheets",
  "spreadsheets:excel-live-control",
  "template-creator:template-creator",
  "visualize:visualize",
  "skill-installer",
  "openai-docs",
]);

export class Hub {
  private live = new Map<string, Live>();
  private approvals = new Map<string, PendingApproval>();
  private commandCache = new Map<string, { at: number; list: Promise<Command[]> }>();
  private tasks = new Map<string, Task>(); // sub-agent thread id -> its latest task
  private taskHistory = new Map<string, Task>();
  private recovered = false;
  private shuttingDown = false;
  private deliveries = new Map<string, Timer>(); // parent thread -> report delivery about to run
  private titling = new Map<string, string>(); // thread -> id of the title request still wanted
  models: ModelOption[] = [];
  limits: Partial<Record<Provider, Limit[]>> = {};

  constructor(
    private store: Store,
    private broadcast: (e: Event) => void,
    private env: { bins: Partial<Record<Provider, string>>; vars: Record<string, string> },
    private git: Git,
    readonly surfaces: Surfaces,
  ) {
    for (const record of this.store.agentTasks()) this.rememberTask(record);
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  private rememberTask(record: AgentTaskRecord): Task {
    const task: Task = { ...record, waiters: new Set() };
    this.taskHistory.set(agentTaskKey(task), task);
    if ((this.tasks.get(task.id)?.generation ?? 0) < task.generation) this.tasks.set(task.id, task);
    return task;
  }

  private saveTask(task: Task) {
    const { waiters, ...record } = task;
    this.store.saveAgentTask(record);
  }

  // Recover identities and results separately from native processes, which cannot survive restart.
  recoverAgents() {
    if (this.recovered) return;
    this.recovered = true;
    for (const child of this.store.threads().filter((t) => t.parentId)) {
      if (!this.tasks.has(child.id) && this.store.thread(child.parentId!)) {
        const items = this.store.items(child.id);
        const last = items.findLast((i) => i.kind === "turn");
        const stopped = last?.kind === "turn" && last.error === "Interrupted";
        this.rememberTask({ id: child.id, parentId: child.parentId!, generation: 1,
          status: stopped ? "cancelled" : "running", delivery: stopped || last ? "acknowledged" : "pending",
          startedAt: child.createdAt, startMessageId: items.find((i) => i.kind === "user")?.id });
      }
    }
    for (const task of this.taskHistory.values()) {
      if (task.delivery === "delivered" || task.delivery === "queued") {
        task.delivery = this.store.stopped(task.parentId) ? "disposed" : "pending";
      }
      if (!agentTerminal(task)) {
        this.state(task.id).reportTo = task.parentId;
        if (task.status === "waiting" && this.store.thread(task.id)?.questions?.length) {
          this.saveTask(task);
          this.notifyQuestion(task);
          continue;
        }
        if (this.openChildren(task).length && task.status !== "cancelling" && !this.store.stopped(task.id)) {
          this.saveTask(task);
          continue;
        }
        const items = this.taskItems(task);
        const last = items.findLast((i) => i.kind === "turn");
        const cancelled = task.status === "cancelling" || this.store.stopped(task.id);
        const error = last?.kind === "turn" ? last.error : "Tack restarted before the agent finished. Use agent_send to continue.";
        task.status = cancelled ? "cancelled" : error ? "failed" : "completed";
        task.body = cancelled ? "Stopped before finishing." : error ?? items.findLast((i) => i.kind === "assistant")?.text ?? "No final message.";
        if (cancelled) task.delivery = "disposed";
      }
      this.saveTask(task);
    }
    for (const parentId of new Set([...this.taskHistory.values()].map((t) => t.parentId))) {
      if (!this.store.thread(parentId)) continue;
      const live = this.state(parentId);
      live.queue = live.queue.filter((q) => !q.tasks || q.tasks.some((key) => {
        const task = this.taskHistory.get(key);
        return task && !["disposed", "acknowledged"].includes(task.delivery);
      }));
      this.emitQueue(parentId);
      if (!live.stopped) this.scheduleReports(parentId, 0);
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const timer of this.deliveries.values()) clearTimeout(timer);
    this.deliveries.clear();
    for (const task of this.taskHistory.values()) for (const wake of [...task.waiters]) wake();
    const preparation: Promise<void>[] = [];
    for (const live of this.live.values()) {
      live.preparing?.abort();
      if (live.preparation) preparation.push(live.preparation);
      if (live.cancelTimer) clearTimeout(live.cancelTimer);
      const session = live.session;
      live.session = undefined;
      session?.close();
    }
    await Promise.allSettled(preparation);
  }

  // ---- titles (T3 Code's flow: initial from the first message, regenerate from the whole thread)

  // Returns right away; the title lands when the model answers. A newer request, or a rename, wins.
  private nameThread(threadId: string, kind: "initial" | "regenerate", first?: { message: string; attachments: Attachment[] }) {
    const requestId = crypto.randomUUID();
    this.titling.set(threadId, requestId);
    this.emitThread(threadId);
    void this.runTitle(threadId, requestId, kind, first)
      .catch((e) => console.warn("tack: could not write a title:", e instanceof Error ? e.message : e))
      .finally(() => {
        if (this.titling.get(threadId) !== requestId) return;
        this.titling.delete(threadId);
        if (this.store.thread(threadId)) this.emitThread(threadId);
      });
  }

  private async runTitle(threadId: string, requestId: string, kind: "initial" | "regenerate", first?: { message: string; attachments: Attachment[] }) {
    const pick = pickTitleModel(this.models, this.env.bins);
    const bin = pick && this.env.bins[pick.provider];
    const thread = this.store.thread(threadId);
    const project = thread && this.store.project(thread.projectId);
    if (!pick || !bin || !thread || !project) return;

    const context = kind === "initial" ? undefined : formatThreadTitleContext(this.store.items(threadId));
    const message = first?.message ?? context!.message;
    if (!message.trim() && !first?.attachments.length) return;
    const linkedContext = await resolveThreadTitleLinks(message, project.path, this.env.vars);
    const previousTitle = kind === "initial" ? undefined : thread.title;
    const images = first ? titleAttachments(first.attachments) : [];

    // T3 retries the first title twice with exponential backoff; a regenerate is the user's to repeat.
    const attempts = kind === "initial" ? 3 : 1;
    let title = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.titling.get(threadId) !== requestId) return;
      try {
        title = (await generateThreadTitle(pick, bin, this.env.vars, project.path, { message, previousTitle, linkedContext, attachments: images, images })).title;
        break;
      } catch (e) {
        if (attempt === attempts - 1) throw e;
        await Bun.sleep(2_000 * 2 ** attempt);
      }
    }
    const current = this.store.thread(threadId);
    if (this.titling.get(threadId) !== requestId || !current) return;
    if (title === "New thread" || title === current.title) return;
    this.store.updateThread(threadId, { title });
  }

  regenerateTitle(threadId: string) {
    const thread = this.store.thread(threadId);
    if (!thread || this.titling.has(threadId)) return;
    this.nameThread(threadId, "regenerate");
  }

  // The user renamed the thread; whatever is still being written is dropped.
  cancelTitle(threadId: string) {
    if (this.titling.delete(threadId)) this.emitThread(threadId);
  }

  // Remembers which branch the project was on, so the sidebar can show it per thread.
  private async noteBranch(threadId: string) {
    const project = this.store.project(this.store.thread(threadId)?.projectId ?? "");
    if (!project) return;
    const branch = await this.git.branch(this.tasks.get(threadId)?.workspace?.path ?? project.path);
    if (this.store.setBranch(threadId, branch)) this.emitThread(threadId);
  }

  // Threads from before branches were tracked get the branch their project is on now.
  async backfillBranches() {
    for (const t of this.store.threads()) {
      if (t.branch || t.parentId) continue;
      const project = this.store.project(t.projectId);
      const branch = project && (await this.git.branch(project.path));
      if (branch && this.store.setBranch(t.id, branch)) this.emitThread(t.id);
    }
  }

  // ---- reads

  threads(): Thread[] {
    return this.store.threads().map((t) => this.withStatus(t));
  }

  thread(id: string): Thread {
    const t = this.store.thread(id);
    if (!t) throw new Error("Thread not found");
    return this.withStatus(t);
  }

  open(threadId: string) {
    const live = this.live.get(threadId);
    return {
      items: this.store.items(threadId),
      queue: this.state(threadId).queue,
      held: !!this.state(threadId).held,
      streaming: live ? [...live.streaming.values()] : [],
      approvals: [...this.approvals.values()].filter((a) => a.request.threadId === threadId).map((a) => a.request),
    };
  }

  defaultModel(): { provider: Provider; model: string; effort: Effort } {
    return { provider: "claude", model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  }

  providerOf(model: string): Provider {
    return this.models.find((m) => m.value === model)?.provider ?? (/^(gpt|o\d|codex)/.test(model) ? "codex" : "claude");
  }

  // Slash commands and skills for a project, from a short-lived probe session (cached briefly).
  commands(projectId: string, provider: Provider): Promise<Command[]> {
    const project = this.store.project(projectId);
    if (!project) return Promise.resolve([]);
    const key = `${provider}:${project.path}`;
    const hit = this.commandCache.get(key);
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return hit.list;
    const probe = createSession(provider, this.probeOptions(provider, project.path), noEvents);
    const list = probe
      .commands()
      .then((all) => [VISUALIZE_COMMAND, ...all.filter((c) => c.name !== "visualize" && !HIDDEN_SKILLS.has(c.name))])
      .catch(() => [VISUALIZE_COMMAND])
      .finally(() => probe.close());
    list.catch(() => this.commandCache.delete(key));
    this.commandCache.set(key, { at: Date.now(), list });
    return list;
  }

  // Claude takes an allowlist, so the hidden skills are subtracted from what the project has.
  // Undefined (all skills) if the list isn't known within a moment.
  private async skillsFor(projectId: string, provider: Provider): Promise<string[] | undefined> {
    if (provider !== "claude") return undefined;
    const timeout = new Promise<undefined>((r) => setTimeout(r, 3000));
    const list = await Promise.race([this.commands(projectId, provider).catch(() => undefined), timeout]);
    return list?.map((c) => c.name); // built-in command names in the list are ignored
  }

  // A CLI was updated: running sessions keep their old process until their next message.
  restartProvider(provider: Provider) {
    for (const live of this.live.values()) {
      if (live.session?.provider !== provider) continue;
      if (live.status === "running") live.stale = true;
      else live.session.close();
    }
    for (const key of this.commandCache.keys()) if (key.startsWith(provider)) this.commandCache.delete(key);
    this.loadModels().catch(() => {});
  }

  // ---- writes

  async configure(threadId: string, patch: { model?: string; effort?: Effort; access?: Access }) {
    const before = this.store.thread(threadId);
    const provider = patch.model ? this.providerOf(patch.model) : before?.provider;
    this.store.updateThread(threadId, { ...patch, provider });
    const live = this.live.get(threadId);
    if (live?.session && !live.session.closed) {
      // Switching provider is handled on the next send, which hands the thread over.
      if (patch.model && provider === live.session.provider) await live.session.setModel(patch.model).catch(() => {});
      // Effort and access are fixed per process; the next send resumes with the new values.
      if (patch.effort || patch.access) live.stale = true;
    }
    return this.emitThread(threadId);
  }

  send(threadId: string, text: string, attachments: Attachment[], steer = true, agents = false) {
    const live = this.state(threadId);
    if (!agents) {
      live.stopped = false;
      this.store.setStopped(threadId, false);
      let retry = false;
      for (const task of this.taskHistory.values()) if (task.parentId === threadId && task.delivery === "pending" && agentTerminal(task)) {
        task.deliveryAttempts = 0;
        this.saveTask(task);
        retry = true;
      }
      if (retry) this.scheduleReports(threadId);
    }
    const queued: Queued = { id: crypto.randomUUID(), text, attachments, ...(agents && { agents }) };
    // After Stop, a message goes behind what was queued, and sending releases the queue. A message that
    // steers a turn that is being stopped would reach nobody.
    if (live.held || (live.stopping && live.status === "running")) {
      live.held = false;
      live.queue.push(queued);
      this.emitQueue(threadId);
      if (live.status !== "running") this.drain(threadId);
      return;
    }
    if (live.status !== "running" && !live.steering) return this.deliver(threadId, queued);
    if (steer || agents) return void this.steerIn(threadId, queued);
    live.queue.push(queued);
    this.emitQueue(threadId);
  }

  // Releases a queue that Stop held.
  resume(threadId: string) {
    const live = this.state(threadId);
    if (!live.held && !live.stopped) return;
    live.held = false;
    live.stopped = false;
    this.store.setStopped(threadId, false);
    let retry = false;
    for (const task of this.taskHistory.values()) if (task.parentId === threadId && task.delivery === "pending" && agentTerminal(task)) {
      task.deliveryAttempts = 0;
      this.saveTask(task);
      retry = true;
    }
    this.emitQueue(threadId);
    if (live.status !== "running") this.drain(threadId);
    if (retry) this.scheduleReports(threadId, 0);
  }

  // Replaces the text of a queued message, keeping its place and attachments.
  edit(threadId: string, queuedId: string, text: string) {
    const live = this.state(threadId);
    const q = live.queue.find((m) => m.id === queuedId);
    if (!q || q.agents || (!text.trim() && !q.attachments.length)) return;
    q.text = text;
    this.emitQueue(threadId);
  }

  // T3's automatic delivery: steer an active provider turn, queue during gaps. Keeping the
  // message in the queue also lets Stop hold it while the provider is deciding whether to accept it.
  private steerIn(threadId: string, queued: Queued) {
    const live = this.state(threadId);
    if (!live.queue.some((q) => q.id === queued.id)) {
      live.queue.push(queued);
      this.emitQueue(threadId);
    }
    const attempt = (live.steering ?? Promise.resolve()).then(async () => {
      if (live.held || live.stopped || live.stopping || live.status !== "running" || !live.queue.includes(queued)) return;
      const submitted = { ...queued };
      if (await this.inject(threadId, submitted) !== "sent") return;
      const index = live.queue.indexOf(queued);
      if (index >= 0) {
        if (queued.text === submitted.text) live.queue.splice(index, 1);
        else live.queue[index] = { ...queued, id: crypto.randomUUID() }; // an edit made while sending is a new follow-up
      }
      this.emitQueue(threadId);
    }).catch((error) => {
      console.warn("tack: could not steer; message remains queued:", error instanceof Error ? error.message : error);
    });
    live.steering = attempt;
    void attempt.then(() => {
      if (live.steering !== attempt) return;
      live.steering = undefined;
      this.drain(threadId);
    });
    return attempt;
  }

  // A provider that cannot take input now leaves it for the next turn, without being stopped.
  private async inject(threadId: string, queued: Queued): Promise<Steered> {
    const live = this.state(threadId);
    const session = live.session;
    if (live.status !== "running" || live.stopped || live.stopping || live.held || !session || session.closed || !session.steer) return "queue";
    const [text, images] = resolveAttachments(queued.text, queued.attachments);
    const how = await session.steer(expandVisualize(text), images);
    if (how !== "sent") return how;
    if (!this.store.thread(threadId) || live.session !== session) return "sent";
    this.recordUser(threadId, queued);
    this.acceptReports(queued.tasks ?? []);
    this.acceptQuestion(queued.agentQuestion);
    if (live.active) live.active.reports.push(...(queued.tasks ?? []));
    this.store.touch(threadId);
    if (live.status !== "running" && live.session === session) {
      // Completion may arrive before the steer acknowledgement; this provider already saw the input.
      this.store.setSession(threadId, session.provider, { seen: this.store.items(threadId).length });
    }
    return "sent";
  }

  private recordUser(threadId: string, queued: Queued) {
    const user: Item = {
      id: queued.id,
      kind: "user",
      text: queued.text,
      attachments: queued.attachments.map((a) => ({ name: a.name, image: a.kind === "image" || isImagePath(a.path) })),
      ...(queued.agents && { agents: true }),
      ts: Date.now(),
    };
    this.store.appendItem(threadId, user);
    this.broadcast({ type: "item", threadId, item: user });
  }

  // "Send now" on a queued message.
  steer(threadId: string, queuedId: string) {
    const live = this.state(threadId);
    const i = live.queue.findIndex((q) => q.id === queuedId);
    if (i < 0) return;
    live.held = false;
    live.stopped = false;
    this.store.setStopped(threadId, false);
    const queued = live.queue[i]!;
    if (live.status === "running" && live.stopping) {
      live.queue.splice(i, 1);
      live.queue.unshift(queued); // the turn is already ending; it goes first
    } else if (live.status === "running" || live.steering) void this.steerIn(threadId, queued);
    else {
      live.queue.splice(i, 1);
      this.deliver(threadId, queued);
    }
    this.emitQueue(threadId);
  }

  unqueue(threadId: string, queuedId: string) {
    const live = this.state(threadId);
    live.queue = live.queue.filter((q) => q.id !== queuedId);
    this.emitQueue(threadId);
  }

  // Stopping a thread stops its sub-agents too, without waking it for their reports.
  async interrupt(threadId: string) {
    const live = this.state(threadId);
    live.stopped = true;
    this.store.setStopped(threadId, true);
    this.disposeReports(threadId);
    const own = this.tasks.get(threadId);
    if (own && !agentTerminal(own)) {
      await this.stopTask(own);
      return;
    }
    if (live?.status === "running") {
      live.stopping = true;
      // Nothing the user queued runs behind a Stop until they say so.
      if (live.queue.length) live.held = true;
      this.emitQueue(threadId);
      const session = live.session;
      const active = live.active;
      if (session) live.cancelTimer ??= setTimeout(() => {
        if (!live.stopping || live.session !== session || live.active !== active) return;
        live.session = undefined;
        session.close();
        this.finishRun(threadId, "Interrupted");
      }, 8000).unref();
    }
    live.preparing?.abort();
    await Promise.all([
      ...[...this.tasks.values()].filter((t) => t.parentId === threadId).map((t) => this.stopTask(t)),
      live.session?.interrupt().catch(() => {}),
    ]);
  }

  answer(approvalId: string, allow: boolean) {
    const pending = this.approvals.get(approvalId);
    if (!pending) return;
    this.approvals.delete(approvalId);
    pending.resolve(allow);
    this.broadcast({ type: "approval.resolved", approvalId });
    const task = this.tasks.get(pending.request.threadId);
    if (task?.status === "waiting" && !this.pendingInput(task).hasPendingQuestion && !this.pendingInput(task).pendingApproval) {
      task.status = "running";
      this.saveTask(task);
      this.emitThread(task.id);
    }
  }

  settle(threadId: string, settled: boolean) {
    this.store.settle(threadId, settled);
    this.emitThread(threadId);
  }

  closeThread(threadId: string) {
    this.disposeReports(threadId);
    const task = this.tasks.get(threadId);
    if (task) {
      task.delivery = "disposed";
      if (!agentTerminal(task)) { task.status = "cancelled"; task.body = "Agent thread was removed."; }
      for (const wake of [...task.waiters]) wake();
      this.tasks.delete(threadId);
    }
    for (const [key, entry] of this.taskHistory) if (entry.id === threadId || entry.parentId === threadId) this.taskHistory.delete(key);
    void this.surfaces.browser.closeThread(threadId);
    const live = this.live.get(threadId);
    live?.preparing?.abort();
    if (live?.cancelTimer) clearTimeout(live.cancelTimer);
    live?.session?.close();
    if (live?.flush) clearTimeout(live.flush);
    this.live.delete(threadId);
    this.titling.delete(threadId);
    for (const [id, a] of this.approvals) if (a.request.threadId === threadId) this.answer(id, false);
  }

  // Ask each installed CLI for its models, without sending a prompt.
  async loadModels() {
    const providers = (["claude", "codex"] as const).filter((p) => this.env.bins[p]);
    const lists = await Promise.all(
      providers.map(async (provider) => {
        const probe = createSession(provider, this.probeOptions(provider, process.env.HOME ?? "/"), noEvents);
        try {
          return await probe.models();
        } catch (e) {
          console.error(`tack: could not load ${provider} models:`, e instanceof Error ? e.message : e);
          return this.models.filter((m) => m.provider === provider);
        } finally {
          probe.close();
        }
      }),
    );
    this.models = lists.flat();
    this.broadcast({ type: "models", models: this.models });
  }

  private probeOptions(provider: Provider, cwd: string): SessionOptions {
    return { cwd, model: provider === "claude" ? DEFAULT_MODEL : "", effort: DEFAULT_EFFORT, access: "full", bin: this.env.bins[provider], env: this.env.vars };
  }

  // ---- internals

  private async deliver(threadId: string, queued: Queued) {
    const thread = this.store.thread(threadId);
    const project = thread && this.store.project(thread.projectId);
    if (!thread || !project) return;
    const live = this.state(threadId);
    if (live.stopped || live.stopping) {
      if (!queued.agents && !live.queue.some((q) => q.id === queued.id)) live.queue.push(queued);
      this.emitQueue(threadId);
      return;
    }
    let task = this.tasks.get(threadId);
    if (queued.reportTo) {
      if (!task || queued.taskGeneration !== task.generation || agentTerminal(task)) task = this.beginTask(threadId, queued.reportTo, queued.id);
      else {
        task.status = "running";
        task.startMessageId ??= queued.id;
        this.saveTask(task);
      }
      live.reportTo = queued.reportTo;
    }
    const active = { id: crypto.randomUUID(), messageId: queued.id, task: task && !agentTerminal(task) ? agentTaskKey(task) : undefined,
      reports: queued.tasks ?? [], question: queued.agentQuestion };
    live.active = active;
    live.turnError = undefined;
    live.status = "running";
    live.lastActive = Date.now();
    const current = () => this.live.get(threadId) === live && live.active === active && !live.stopping && !live.stopped && !!this.store.thread(threadId);
    try {
      const history = this.store.items(threadId);
      const native = this.store.session(threadId, thread.provider);
      const upgradeTools = thread.provider === "codex" && native.id && native.toolsVersion !== TOOLS_VERSION;
      const missed = upgradeTools ? history : history.slice(native.seen ?? (native.id ? history.length : 0));
      const from: Provider = thread.provider === "claude" ? "codex" : "claude";
      const carry = missed.length ? handoff(missed, from) : undefined;
      if (carry) {
        const marker: Item = { id: crypto.randomUUID(), kind: "handoff", from, to: thread.provider, carried: carry.carried, ts: Date.now() };
        this.store.appendItem(threadId, marker);
        this.broadcast({ type: "item", threadId, item: marker });
      }
      this.recordUser(threadId, queued);
      this.store.settle(threadId, null);
      if (!queued.agents) {
        if (thread.title === "New thread" && queued.text.trim()) {
          this.store.updateThread(threadId, { title: titleFrom(queued.text) });
          if (!thread.parentId) this.nameThread(threadId, "initial", { message: queued.text, attachments: queued.attachments });
        }
        if (thread.questions) this.store.setQuestions(threadId, null);
      }
      this.store.touch(threadId);
      this.emitThread(threadId);
      void this.noteBranch(threadId);
      if (live.stale || (live.session && live.session.provider !== thread.provider)) {
        const old = live.session;
        live.session = undefined;
        old?.close();
        live.stale = false;
      }
      if (!live.session || live.session.closed) {
        const skills = await this.skillsFor(project.id, thread.provider);
        if (!current()) { if (live.active === active) this.finishRun(threadId, "Interrupted"); return; }
        const models = this.models.filter((m) => m.group === "latest");
        const session: AgentSession = createSession(thread.provider, {
          cwd: task?.workspace?.path ?? project.path, model: thread.model, effort: thread.effort, access: thread.access,
          resume: upgradeTools ? undefined : native.id, bin: this.env.bins[thread.provider], env: this.env.vars, skills,
          role: thread.parentId ? "agent" : "main",
          agentModels: models.length ? models : [{ value: thread.model, provider: thread.provider }],
        }, this.sessionEvents(threadId, thread.provider, () => session));
        live.session = session;
      }
      if (!current()) { if (live.active === active) this.finishRun(threadId, "Interrupted"); return; }
      const [text, images] = resolveAttachments(queued.text, queued.attachments);
      live.session.send((carry?.text ?? "") + expandVisualize(text), images);
    } catch (error) {
      if (live.active !== active) return;
      const text = error instanceof Error ? error.message : String(error);
      if (!live.stopped) {
        const item: Item = { id: crypto.randomUUID(), kind: "error", text, ts: Date.now() };
        this.store.appendItem(threadId, item);
        this.broadcast({ type: "item", threadId, item });
      }
      this.finishRun(threadId, text);
    }
  }

  private sessionEvents(threadId: string, provider: Provider, self: () => AgentSession): SessionEvents {
    const current = () => {
      const live = this.live.get(threadId);
      return live?.session === self() ? live : undefined;
    };
    const approve = (tool: string, input: unknown, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      if (signal.aborted || !current() || current()?.stopped) return resolve(false);
      const request: ApprovalRequest = { id: crypto.randomUUID(), threadId, provider, tool, input };
      this.approvals.set(request.id, { request, resolve });
      signal.addEventListener("abort", () => this.answer(request.id, false), { once: true });
      const task = this.tasks.get(threadId);
      if (task && !agentTerminal(task)) { task.status = "waiting"; this.saveTask(task); this.emitThread(threadId); }
      this.broadcast({ type: "approval", request });
      this.wakeTaskWaiters(threadId);
      if (signal.aborted) this.answer(request.id, false);
    });
    return {
      item: (item, final) => {
        const live = current();
        if (!live) return;
        live.deltas.delete(item.id);
        if (final) {
          live.streaming.delete(item.id);
          this.store.appendItem(threadId, item);
          if (item.kind === "turn") live.turnError = item.error;
          if (item.kind === "error") live.turnError = item.text;
          if (item.kind === "tool" && item.output) this.notePrs(threadId, item);
        } else live.streaming.set(item.id, item);
        this.broadcast({ type: "item", threadId, item: { ...item } });
      },
      delta: (itemId, text) => {
        const live = current();
        if (!live) return;
        live.deltas.set(itemId, (live.deltas.get(itemId) ?? "") + text);
        live.flush ??= setTimeout(() => this.flushDeltas(threadId), DELTA_FLUSH_MS);
      },
      sessionId: (id) => { if (current()) this.store.setSession(threadId, provider, { id, toolsVersion: TOOLS_VERSION }); },
      usage: (used, window) => { if (current()) { this.store.setContext(threadId, { used, window }); this.emitThread(threadId); } },
      limits: (limits) => {
        const merged = new Map((this.limits[provider] ?? []).map((l) => [l.kind, l]));
        for (const limit of limits) merged.set(limit.kind, limit);
        this.limits[provider] = [...merged.values()];
        this.broadcast({ type: "limits", provider, limits: this.limits[provider] });
      },
      turnStart: () => {
        const live = current();
        if (!live) return;
        this.acceptReports(live.active?.reports ?? []);
        this.acceptQuestion(live.active?.question);
      },
      turnEnd: () => {
        const live = current();
        if (!live) return;
        this.flushDeltas(threadId);
        this.store.setSession(threadId, provider, { seen: this.store.items(threadId).length });
        this.finishRun(threadId, live.turnError);
        void this.noteBranch(threadId);
      },
      closed: (error) => {
        const live = current();
        if (!live) return;
        this.flushDeltas(threadId);
        live.streaming.clear();
        live.session = undefined;
        if (live.status === "running") this.finishRun(threadId, error ?? (live.stopped ? "Interrupted" : "Agent session closed before finishing."));
      },
      approve,
      ask: (questions) => {
        if (!current() || current()?.stopped) return;
        this.store.setQuestions(threadId, questions);
        const task = this.tasks.get(threadId);
        if (task && !agentTerminal(task)) {
          task.status = "waiting";
          task.questionId = crypto.randomUUID();
          task.questionNotified = false;
          this.saveTask(task);
        }
        this.emitThread(threadId);
        this.wakeTaskWaiters(threadId);
        if (task) this.scheduleReports(task.parentId);
      },
      agent: (tool, input, signal, requestKey) => current() ? this.agentCall(threadId, tool, input, signal, requestKey) : JSON.stringify({ error: "Agent session is no longer active.", started: false }),
      surface: (name, input, signal) => this.surfaces.execute(threadId, name, input, signal,
        () => approve("BrowserInstall", {}, signal ?? new AbortController().signal)),
    };
  }

  // A PR an agent opened (`gh pr create`, or a GitHub tool) is kept on the top thread, so the
  // thread shows it with its live state. Other PR links in output (lists, views) are ignored.
  private notePrs(threadId: string, item: Extract<Item, { kind: "tool" }>) {
    const input = JSON.stringify(item.input ?? "");
    if (!/gh pr create|create_pull_request/.test(input + item.name)) return;
    const root = this.store.thread(threadId)?.parentId ?? threadId;
    let added = false;
    for (const url of item.output!.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []) added = this.store.addPr(root, url) || added;
    if (added) this.emitThread(root);
  }

  // ---- sub-agents

  private async agentCall(parentId: string, tool: AgentTool, input: unknown, signal?: AbortSignal, requestKey?: string): Promise<string> {
    const parsed = z.object(TOOLS[tool].input).safeParse(input);
    if (!parsed.success) return JSON.stringify({ error: parsed.error.issues.map((i) => i.message).join('; '), started: false });
    input = parsed.data;
    if ((tool === "agent" || tool === "agent_send") && (signal?.aborted || this.state(parentId).stopped || this.state(parentId).stopping)) {
      return JSON.stringify({ error: "The parent was stopped. Send a new message before starting more work.", started: false });
    }
    if (tool === "agent") return this.spawn(parentId, input as AgentInput, signal, requestKey);
    const { id, generation } = input as { id: string; generation?: number };
    const task = generation === undefined ? this.tasks.get(id) : this.taskHistory.get(`${id}:${generation}`);
    if (!task || task.parentId !== parentId) return JSON.stringify({ error: `No agent "${id}" among yours.`, started: false });
    if (tool === "agent_cancel") {
      await this.stopTask(task);
      return this.taskText(task);
    }
    if (tool === "agent_send") return this.sendToAgent(this.tasks.get(id)!, input as AgentSendInput);
    const { wait, timeoutMs } = input as AgentStatusInput;
    if (wait) await this.waitFor(task, timeoutMs, signal);
    return this.taskText(task);
  }

  private async spawn(parentId: string, input: AgentInput, signal?: AbortSignal, callKey?: string): Promise<string> {
    const parent = this.store.thread(parentId);
    if (!parent) return JSON.stringify({ error: "Parent thread not found.", started: false });
    const requestKey = input.requestKey ?? callKey;
    const existing = requestKey && [...this.taskHistory.values()].find((t) => t.parentId === parentId && t.requestKey === requestKey);
    if (existing) return this.taskText(existing);
    const running = [...this.tasks.values()].filter((t) => !agentTerminal(t));
    if (running.filter((t) => t.parentId === parentId).length >= MAX_RUNNING_AGENTS || running.length >= 48) {
      return JSON.stringify({ error: "Agent concurrency limit reached. Wait for existing agents to finish.", started: false });
    }
    let ancestor: Thread | undefined = parent;
    const seen = new Set<string>();
    while (ancestor) {
      if (seen.has(ancestor.id) || seen.size >= 8) return JSON.stringify({ error: "Agent nesting limit reached.", started: false });
      seen.add(ancestor.id);
      ancestor = ancestor.parentId ? this.store.thread(ancestor.parentId) : undefined;
    }
    if (signal?.aborted || this.state(parentId).stopped || this.state(parentId).stopping) return JSON.stringify({ error: "Parent stopped.", started: false });
    const model = input.model ?? parent.model;
    const option = this.models.find((m) => m.value === model);
    if (this.models.length && !option) return JSON.stringify({ error: `Unknown model "${model}".`, started: false });
    const wanted = input.effort ?? parent.effort;
    const effort = !option || option.efforts.includes(wanted) ? wanted : option.efforts.includes("medium") ? "medium" : option.efforts[0]!;
    const taken = new Set(this.store.threads().filter((t) => t.parentId === parentId).map((t) => t.title));
    let name = input.name.trim();
    for (let n = 2; taken.has(name); n++) name = `${input.name.trim()} ${n}`;
    const child = this.store.createThread(parent.projectId, this.providerOf(model), model, effort, { parentId, title: name, access: parent.access });
    const queued: Queued = { id: crypto.randomUUID(), text: input.task, attachments: [], reportTo: parentId };
    const task = this.beginTask(child.id, parentId, queued.id, requestKey);
    queued.taskGeneration = task.generation;
    const live = this.state(child.id);
    const preparation = new AbortController();
    live.preparing = preparation;
    live.status = "running";
    this.emitThread(child.id);
    const projectPath = this.tasks.get(parentId)?.workspace?.path ?? this.store.project(parent.projectId)!.path;
    live.preparation = (async () => {
      try {
        task.workspace = await prepareAgentWorkspace(projectPath, child.id, input.isolation ?? "shared", preparation.signal,
          this.env.vars.TACK_DATA_DIR ? join(this.env.vars.TACK_DATA_DIR, "agent-worktrees") : undefined);
        this.saveTask(task);
        preparation.signal.throwIfAborted();
        if (live.stopped || live.stopping) throw new Error("Interrupted");
        live.preparing = undefined;
        await this.deliver(child.id, queued);
      } catch (error) {
        if (live.preparing === preparation) live.preparing = undefined;
        if (!this.shuttingDown) this.finishRun(child.id, error instanceof Error ? error.message : String(error));
      }
    })();
    if (input.mode === "wait") await this.waitFor(task, input.timeoutMs, signal);
    return this.taskText(task);
  }

  private beginTask(childId: string, parentId: string, messageId?: string, requestKey?: string): Task {
    const previous = this.tasks.get(childId);
    const task = this.rememberTask({ id: childId, parentId, generation: (previous?.generation ?? 0) + 1,
      parentGeneration: this.tasks.get(parentId)?.generation,
      status: "running", delivery: "pending", startedAt: Date.now(), startMessageId: messageId,
      requestKey, workspace: previous?.workspace });
    this.state(childId).reportTo = parentId;
    this.saveTask(task);
    return task;
  }

  private taskItems(task: Task): Item[] {
    const items = this.store.items(task.id);
    const start = task.startMessageId ? items.findIndex((i) => i.id === task.startMessageId) : -1;
    return start >= 0 ? items.slice(start + 1) : task.startMessageId ? [] : items;
  }

  private openChildren(task: Task) {
    return [...this.taskHistory.values()].filter((child) => child.parentId === task.id
      && (child.parentGeneration === undefined || child.parentGeneration === task.generation)
      && (!agentTerminal(child) || !["acknowledged", "disposed"].includes(child.delivery)));
  }

  private descendants(id: string): Set<string> {
    const found = new Set([id]);
    const threads = this.store.threads();
    for (let changed = true; changed;) {
      changed = false;
      for (const thread of threads) if (thread.parentId && found.has(thread.parentId) && !found.has(thread.id)) {
        found.add(thread.id);
        changed = true;
      }
    }
    return found;
  }

  private pendingInput(task: Task) {
    const ids = this.descendants(task.id);
    const child = this.store.threads().find((t) => ids.has(t.id) && t.questions?.length);
    const approval = [...this.approvals.values()].find((a) => ids.has(a.request.threadId))?.request;
    return { hasPendingQuestion: !!child, questions: child?.questions, questionThreadId: child?.id,
      pendingApproval: approval ? { id: approval.id, threadId: approval.threadId, tool: approval.tool } : null };
  }

  private wakeTaskWaiters(childId: string) {
    for (const task of this.tasks.values()) if (this.descendants(task.id).has(childId)) {
      const pending = this.pendingInput(task);
      if (agentTerminal(task) || pending.hasPendingQuestion || pending.pendingApproval) for (const wake of [...task.waiters]) wake();
      if (this.store.thread(task.id)) this.emitThread(task.id);
    }
  }

  private waitFor(task: Task, timeoutMs = AGENT_WAIT_MS, signal?: AbortSignal): Promise<void> {
    const ready = () => agentTerminal(task) || this.pendingInput(task).hasPendingQuestion || !!this.pendingInput(task).pendingApproval;
    if (signal?.aborted || ready()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        task.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(3_600_000, Math.max(1, timeoutMs)));
      task.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted || ready()) done();
    });
  }

  private taskText(task: Task): string {
    const child = this.store.thread(task.id);
    const pending = this.pendingInput(task);
    if (pending.questionThreadId) {
      const waiting = this.tasks.get(pending.questionThreadId);
      if (waiting) this.dismissQuestion(waiting);
    }
    if (agentTerminal(task)) this.acknowledge(task);
    return JSON.stringify({ id: task.id, threadId: task.id, generation: task.generation,
      name: child?.title ?? "Agent", model: child?.model, status: !agentTerminal(task) && (pending.hasPendingQuestion || pending.pendingApproval) ? "waiting" : task.status,
      result: task.body, workspace: task.workspace, ...pending,
      notification: agentTerminal(task) ? "Result read; no duplicate completion notification will be sent."
        : task.status === "cancelling" ? "Cancellation requested; waiting for execution to stop."
        : "Completion wakes you with the report. Continue your own work; do not poll." });
  }

  private acknowledge(task: Task) {
    if (task.delivery !== "disposed") task.delivery = "acknowledged";
    if (!this.store.thread(task.id) || !this.store.thread(task.parentId)) return;
    const live = this.state(task.parentId);
    const key = agentTaskKey(task);
    live.queue = live.queue.flatMap((q) => {
      if (!q.tasks?.includes(key)) return [q];
      const left = q.tasks.filter((id) => id !== key);
      return left.length ? [{ ...q, tasks: left, text: this.reportsText(left.flatMap((id) => this.taskHistory.get(id) ?? []), task.parentId) }] : [];
    });
    const { waiters, ...record } = task;
    this.store.saveAgentState([record], [{ threadId: task.parentId, queue: live.queue, held: !!live.held }]);
    this.emitQueue(task.parentId);
  }

  private dismissQuestion(task: Task) {
    task.questionNotified = true;
    const parent = this.state(task.parentId);
    parent.queue = parent.queue.filter((q) => q.agentQuestion?.childId !== task.id || q.agentQuestion.generation !== task.generation);
    const { waiters, ...record } = task;
    this.store.saveAgentState([record], [{ threadId: task.parentId, queue: parent.queue, held: !!parent.held }]);
    this.emitQueue(task.parentId);
  }

  private disposeReports(parentId: string) {
    const live = this.state(parentId);
    clearTimeout(this.deliveries.get(parentId));
    this.deliveries.delete(parentId);
    const changed: AgentTaskRecord[] = [];
    for (const task of this.taskHistory.values()) if (task.parentId === parentId && !["acknowledged", "disposed"].includes(task.delivery)) {
      task.delivery = "disposed";
      const { waiters, ...record } = task;
      changed.push(record);
    }
    live.queue = live.queue.filter((q) => !q.agents);
    this.store.saveAgentState(changed, [{ threadId: parentId, queue: live.queue, held: !!live.held }]);
    this.emitQueue(parentId);
  }

  private async stopTask(task: Task): Promise<void> {
    const live = this.state(task.id);
    live.stopped = true;
    live.stopping = live.status === "running" || !!live.preparing;
    live.held = true;
    this.store.setStopped(task.id, true);
    this.store.setQuestions(task.id, null);
    live.queue = [];
    this.disposeReports(task.id);
    task.delivery = "disposed";
    if (!agentTerminal(task)) {
      task.status = live.stopping ? "cancelling" : "cancelled";
      task.body = "Stopped before finishing.";
    }
    this.saveTask(task);
    this.acknowledge(task);
    this.dismissQuestion(task);
    this.emitThread(task.id);
    this.wakeTaskWaiters(task.id);
    live.preparing?.abort();
    const children = [...this.tasks.values()].filter((t) => t.parentId === task.id && !agentTerminal(t));
    await Promise.all(children.map((t) => this.stopTask(t)));
    if (!live.stopping) return;
    if (!live.session && !live.preparing) {
      this.finishRun(task.id, "Interrupted");
      return;
    }
    live.cancelTimer ??= setTimeout(() => {
      if (!live.stopping) return;
      const session = live.session;
      live.session = undefined;
      session?.close();
      this.finishRun(task.id, "Interrupted");
    }, 8000).unref();
    await live.session?.interrupt().catch(() => {});
  }

  private async sendToAgent(task: Task, input: AgentSendInput): Promise<string> {
    const child = this.state(task.id);
    const continuation = task.status === "waiting" && !!this.store.thread(task.id)?.questions?.length;
    const queued: Queued = { id: crypto.randomUUID(), text: input.message, attachments: [], reportTo: task.parentId,
      ...(continuation && { taskGeneration: task.generation }) };
    if (continuation) {
      this.dismissQuestion(task);
      this.store.setQuestions(task.id, null);
      task.status = "running";
      this.saveTask(task);
    }
    child.stopped = false;
    child.held = false;
    this.store.setStopped(task.id, false);
    if (child.stopping || task.status === "cancelling") {
      child.queue.push(queued);
      this.emitQueue(task.id);
      return JSON.stringify({ id: task.id, status: "queued", notification: "Runs after cancellation settles; completion wakes you." });
    }
    if (child.status === "running" || child.steering) {
      if (input.mode === "queue") {
        child.queue.push(queued);
        this.emitQueue(task.id);
      } else await this.steerIn(task.id, queued);
      return JSON.stringify({ id: task.id, status: child.queue.includes(queued) ? "queued" : "sent", notification: "Completion wakes you." });
    }
    if (input.mode === "steer") return JSON.stringify({ error: "Agent is not running; use auto to restart it." });
    await this.deliver(task.id, queued);
    return this.taskText(this.tasks.get(task.id)!);
  }

  async answerAgent(threadId: string, text: string) {
    const task = this.tasks.get(threadId);
    if (!task || !this.store.thread(threadId)?.questions?.length || !text.trim()) throw new Error("No pending agent question.");
    await this.sendToAgent(task, { id: threadId, message: text.trim(), mode: "auto" });
  }

  private report(childId: string, key?: string) {
    const live = this.state(childId);
    const task = key ? this.taskHistory.get(key) : this.tasks.get(childId);
    if (!task || agentTerminal(task)) return;
    const cancelled = task.status === "cancelling" || !!live.stopped;
    if (!cancelled && !live.turnError && this.store.thread(childId)?.questions?.length) {
      task.status = "waiting";
      this.saveTask(task);
      this.emitThread(childId);
      this.wakeTaskWaiters(childId);
      this.notifyQuestion(task);
      return;
    }
    if (!cancelled && !live.turnError && this.openChildren(task).length) {
      task.status = "running";
      this.saveTask(task);
      this.emitThread(childId);
      return;
    }
    live.reportTo = undefined;
    const items = this.taskItems(task);
    const turn = items.findLast((i) => i.kind === "turn");
    const error = live.turnError ?? (turn?.kind === "turn" ? turn.error : undefined)
      ?? items.findLast((i) => i.kind === "error")?.text;
    task.status = cancelled ? "cancelled" : error ? "failed" : "completed";
    task.body = cancelled ? "Stopped before finishing." : error ?? items.findLast((i) => i.kind === "assistant")?.text ?? "No final message.";
    if (cancelled || this.state(task.parentId).stopped) task.delivery = "disposed";
    this.saveTask(task);
    this.emitThread(childId);
    this.wakeTaskWaiters(childId);
    this.scheduleReports(task.parentId);
  }

  private notifyQuestion(task: Task) {
    if (this.state(task.parentId).stopped || !task.questionId || task.questionNotified) return;
    const live = this.state(task.parentId);
    if (live.queue.some((q) => q.id === task.questionId)) return;
    const questions = this.store.thread(task.id)?.questions;
    if (!questions?.length) return;
    const queued: Queued = { id: task.questionId, text: `Agent ${this.store.thread(task.id)?.title} (id ${task.id}) needs input:\n${JSON.stringify(questions)}\nAnswer using agent_send, or ask the user if needed.`,
      attachments: [], agents: true, agentQuestion: { childId: task.id, generation: task.generation } };
    if (live.status === "running" || live.steering) void this.steerIn(task.parentId, queued);
    else {
      live.queue.push(queued);
      this.emitQueue(task.parentId);
      this.drain(task.parentId);
    }
  }

  private scheduleReports(parentId: string, delay = REPORT_COALESCE_MS) {
    if (this.shuttingDown || this.deliveries.has(parentId) || this.state(parentId).stopped) return;
    this.deliveries.set(parentId, setTimeout(() => {
      this.deliveries.delete(parentId);
      this.deliverReports(parentId);
    }, delay));
  }

  private deliverReports(parentId: string) {
    if (!this.store.thread(parentId) || this.state(parentId).stopped) return;
    const live = this.state(parentId);
    for (const task of this.tasks.values()) if (task.parentId === parentId && task.status === "waiting") this.notifyQuestion(task);
    const ready = [...this.taskHistory.values()].filter((t) => t.parentId === parentId && agentTerminal(t) && t.delivery === "pending");
    const groups = new Map<string, Task[]>();
    for (const task of ready) {
      const key = task.deliveryId ?? "new";
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    for (const [groupId, tasks] of groups) {
      const id = groupId === "new" ? crypto.randomUUID() : groupId;
      const keys = tasks.map(agentTaskKey);
      for (const task of tasks) { task.delivery = "queued"; task.deliveryId = id; }
      const queued: Queued = { id, text: this.reportsText(tasks, parentId), attachments: [], agents: true, tasks: keys };
      const old = live.queue.findIndex((q) => q.id === id);
      if (old >= 0) live.queue[old] = queued;
      else live.queue.push(queued);
      this.store.saveAgentState(tasks.map(({ waiters, ...t }) => t), [{ threadId: parentId, queue: live.queue, held: !!live.held }]);
      this.emitQueue(parentId);
      if (live.status === "running" || live.steering) void this.steerIn(parentId, queued);
      else this.drain(parentId);
    }
  }

  private reportsText(tasks: Task[], parentId: string): string {
    let budget = REPORT_INLINE_BYTES;
    const sections = tasks.map((t) => {
      const child = this.store.thread(t.id);
      const head = `## ${child?.title ?? "Agent"} (${child?.model}, ${t.status}, id ${t.id}, generation ${t.generation})`;
      const body = t.body ?? "No final message.";
      const bytes = Buffer.byteLength(body);
      if (bytes > budget) return `${head}\nToo long to inline: read agent_status with id ${t.id} and generation ${t.generation}.`;
      budget -= bytes;
      return `${head}\n${body}`;
    });
    return `<agent-reports>\n${sections.join("\n\n")}\n</agent-reports>\nReports from your sub-agents. Verify before relying on them.`;
  }

  private acceptReports(keys: string[]) {
    for (const key of keys) {
      const task = this.taskHistory.get(key);
      if (task && !["acknowledged", "disposed"].includes(task.delivery)) { task.delivery = "delivered"; this.saveTask(task); }
    }
  }

  private acceptQuestion(question?: Queued["agentQuestion"]) {
    if (!question) return;
    const task = this.taskHistory.get(`${question.childId}:${question.generation}`);
    if (task) { task.questionNotified = true; this.saveTask(task); }
  }

  private finishRun(threadId: string, error?: string) {
    if (this.shuttingDown) return;
    const live = this.live.get(threadId);
    if (!live) return;
    if (error) live.turnError = error;
    const active = live.active;
    if (live.cancelTimer) clearTimeout(live.cancelTimer);
    live.cancelTimer = undefined;
    live.status = error && !live.stopped ? "error" : "idle";
    live.stopping = false;
    live.active = undefined;
    live.lastActive = Date.now();
    this.store.touch(threadId);
    for (const key of active?.reports ?? []) {
      const task = this.taskHistory.get(key);
      if (!task || ["acknowledged", "disposed"].includes(task.delivery)) continue;
      task.delivery = live.stopped ? "disposed" : live.turnError ? "pending" : "acknowledged";
      if (task.delivery === "pending") task.deliveryAttempts = (task.deliveryAttempts ?? 0) + 1;
      this.saveTask(task);
      if (task.delivery === "pending" && task.deliveryAttempts! < 5) {
        this.scheduleReports(threadId, Math.min(30_000, REPORT_COALESCE_MS * 2 ** task.deliveryAttempts!));
      } else if (task.delivery === "pending") {
        live.held = true;
        this.emitQueue(threadId);
      }
    }
    if (live.reportTo || active?.task) this.report(threadId, active?.task);
    this.emitThread(threadId);
    this.drain(threadId);
  }

  private drain(threadId: string) {
    const live = this.state(threadId);
    if (this.shuttingDown || live.held || live.stopped || live.steering || live.status === "running") return;
    const next = live.queue.shift();
    if (!next) return;
    this.emitQueue(threadId);
    void this.deliver(threadId, next);
  }

  private flushDeltas(threadId: string) {
    const live = this.live.get(threadId);
    if (!live) return;
    if (live.flush) clearTimeout(live.flush);
    live.flush = undefined;
    for (const [itemId, text] of live.deltas) this.broadcast({ type: "delta", threadId, itemId, text });
    live.deltas.clear();
  }

  private reapIdle() {
    const now = Date.now();
    for (const live of this.live.values()) {
      if (live.session && live.status !== "running" && now - live.lastActive > IDLE_CLOSE_MS) live.session.close();
    }
  }

  private state(threadId: string): Live {
    let live = this.live.get(threadId);
    if (!live) {
      // Messages queued before a restart wait, held, until the user resumes or sends.
      const saved = this.store.queue(threadId);
      live = { status: "idle", queue: saved, held: this.store.queueHeld(threadId) ?? saved.some((q) => !q.agents),
        stopped: this.store.stopped(threadId), streaming: new Map(), deltas: new Map(), lastActive: Date.now() };
      this.live.set(threadId, live);
    }
    return live;
  }

  private withStatus(t: Thread): Thread {
    const task = this.tasks.get(t.id);
    const pending = task && !agentTerminal(task) ? this.pendingInput(task) : undefined;
    return { ...t, status: this.live.get(t.id)?.status ?? "idle",
      ...(task && { agent: { generation: task.generation, status: pending?.hasPendingQuestion || pending?.pendingApproval ? "waiting" as const : task.status }, workspace: task.workspace }),
      ...(this.titling.has(t.id) && { titling: true }) };
  }

  private emitThread(threadId: string): Thread {
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread.upserted", thread });
    return thread;
  }

  private emitQueue(threadId: string) {
    const live = this.state(threadId);
    this.store.setQueue(threadId, live.queue, !!live.held);
    this.broadcast({ type: "queue", threadId, queue: live.queue, held: !!live.held });
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function isImagePath(path: string) {
  return (path.split(".").pop()?.toLowerCase() ?? "") in IMAGE_TYPES;
}

// Inline image files as base64; reference everything else by path so the agent reads it itself.
function resolveAttachments(text: string, attachments: Attachment[]): [string, Attachment[]] {
  const images: Attachment[] = [];
  const paths: string[] = [];
  for (const a of attachments) {
    if (a.kind === "image") images.push(a);
    else if (isImagePath(a.path)) {
      const mediaType = IMAGE_TYPES[a.path.split(".").pop()!.toLowerCase()]!;
      images.push({ kind: "image", name: a.name, mediaType, data: readFileSync(a.path).toString("base64") });
    } else paths.push(a.path);
  }
  const refs = paths.length ? `\n\nAttached files:\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
  return [text + refs, images];
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line;
}
