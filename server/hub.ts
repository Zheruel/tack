// Orchestration: owns live sessions, the per-thread queue, streaming state and approvals.

import { readFileSync } from "node:fs";
import { ClaudeSession } from "./claude";
import { CodexSession } from "./codex";
import { handoff } from "./handoff";
import { noEvents, type AgentSession, type SessionEvents, type SessionOptions } from "./session";
import type { Store } from "./store";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../shared/protocol";
import type {
  Access,
  ApprovalRequest,
  Attachment,
  Command,
  Effort,
  Event,
  Item,
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

function createSession(provider: Provider, opts: SessionOptions, events: SessionEvents): AgentSession {
  return provider === "codex" ? new CodexSession(opts, events) : new ClaudeSession(opts, events);
}

interface Live {
  session?: AgentSession;
  stale?: boolean; // options changed that need a fresh process; applied on next send
  status: ThreadStatus;
  queue: Queued[];
  streaming: Map<string, Item>;
  deltas: Map<string, string>;
  flush?: Timer;
  lastActive: number;
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
  // Codex
  "documents:documents",
  "pdf:pdf",
  "presentations:Presentations",
  "spreadsheets:Spreadsheets",
  "spreadsheets:excel-live-control",
  "template-creator:template-creator",
  "visualize:visualize",
  "skill-installer",
]);

export class Hub {
  private live = new Map<string, Live>();
  private approvals = new Map<string, PendingApproval>();
  private commandCache = new Map<string, { at: number; list: Promise<Command[]> }>();
  models: ModelOption[] = [];

  constructor(
    private store: Store,
    private broadcast: (e: Event) => void,
    private env: { bins: Partial<Record<Provider, string>>; vars: Record<string, string> },
  ) {
    setInterval(() => this.reapIdle(), 60_000).unref();
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
      queue: live?.queue ?? [],
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
      .then((all) => all.filter((c) => !HIDDEN_SKILLS.has(c.name)))
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

  send(threadId: string, text: string, attachments: Attachment[], steer = false) {
    const live = this.state(threadId);
    const queued: Queued = { id: crypto.randomUUID(), text, attachments };
    if (live.status !== "running") return this.deliver(threadId, queued);
    if (steer) {
      live.queue.unshift(queued);
      live.session?.interrupt();
    } else {
      live.queue.push(queued);
    }
    this.emitQueue(threadId);
  }

  steer(threadId: string, queuedId: string) {
    const live = this.state(threadId);
    const i = live.queue.findIndex((q) => q.id === queuedId);
    if (i < 0) return;
    live.queue.unshift(...live.queue.splice(i, 1));
    this.emitQueue(threadId);
    if (live.status === "running") live.session?.interrupt();
    else this.drain(threadId);
  }

  unqueue(threadId: string, queuedId: string) {
    const live = this.state(threadId);
    live.queue = live.queue.filter((q) => q.id !== queuedId);
    this.emitQueue(threadId);
  }

  async interrupt(threadId: string) {
    await this.live.get(threadId)?.session?.interrupt();
  }

  answer(approvalId: string, allow: boolean) {
    const pending = this.approvals.get(approvalId);
    if (!pending) return;
    this.approvals.delete(approvalId);
    pending.resolve(allow);
    this.broadcast({ type: "approval.resolved", approvalId });
  }

  settle(threadId: string, settled: boolean) {
    this.store.settle(threadId, settled);
    this.emitThread(threadId);
  }

  closeThread(threadId: string) {
    const live = this.live.get(threadId);
    live?.session?.close();
    if (live?.flush) clearTimeout(live.flush);
    this.live.delete(threadId);
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
    const provider = thread.provider;

    // Whatever this provider missed while another one had the thread goes ahead of the message.
    const history = this.store.items(threadId);
    const native = this.store.session(threadId, provider);
    const missed = history.slice(native.seen ?? (native.id ? history.length : 0));
    const from: Provider = provider === "claude" ? "codex" : "claude";
    const carry = missed.length ? handoff(missed, from) : undefined;
    if (carry) {
      const marker: Item = { id: crypto.randomUUID(), kind: "handoff", from, to: provider, carried: carry.carried, ts: Date.now() };
      this.store.appendItem(threadId, marker);
      this.broadcast({ type: "item", threadId, item: marker });
    }

    const user: Item = {
      id: queued.id,
      kind: "user",
      text: queued.text,
      attachments: queued.attachments.map((a) => ({ name: a.name, image: a.kind === "image" || isImagePath(a.path) })),
      ts: Date.now(),
    };
    this.store.appendItem(threadId, user);
    this.store.settle(threadId, null);
    this.broadcast({ type: "item", threadId, item: user });
    if (thread.title === "New thread" && queued.text.trim()) this.store.updateThread(threadId, { title: titleFrom(queued.text) });
    if (thread.todos?.length) this.store.setTodos(threadId, []); // the list belongs to one request
    if (thread.questions) this.store.setQuestions(threadId, null); // this message answers them
    live.status = "running";
    live.lastActive = Date.now();
    this.store.touch(threadId);
    this.emitThread(threadId);

    if (live.stale || (live.session && live.session.provider !== provider)) {
      live.session?.close();
      live.session = undefined;
      live.stale = false;
    }
    if (!live.session || live.session.closed) {
      const skills = await this.skillsFor(project.id, provider);
      try {
        const session: AgentSession = createSession(
          provider,
          {
            cwd: project.path,
            model: thread.model,
            effort: thread.effort,
            access: thread.access,
            resume: native.id,
            bin: this.env.bins[provider],
            env: this.env.vars,
            skills,
          },
          this.sessionEvents(threadId, provider, () => session),
        );
        live.session = session;
      } catch (e) {
        const item: Item = { id: crypto.randomUUID(), kind: "error", text: e instanceof Error ? e.message : String(e), ts: Date.now() };
        this.store.appendItem(threadId, item);
        this.broadcast({ type: "item", threadId, item });
        live.status = "error";
        this.emitThread(threadId);
        return;
      }
    }
    const [text, images] = resolveAttachments(queued.text, queued.attachments);
    live.session.send((carry?.text ?? "") + text, images);
  }

  private sessionEvents(threadId: string, provider: Provider, self: () => AgentSession): SessionEvents {
    const live = () => this.state(threadId);
    return {
      item: (item: Item, final: boolean) => {
        const l = live();
        l.deltas.delete(item.id);
        if (final) {
          l.streaming.delete(item.id);
          this.store.appendItem(threadId, item);
        } else {
          l.streaming.set(item.id, item);
        }
        this.broadcast({ type: "item", threadId, item: { ...item } });
      },
      delta: (itemId: string, text: string) => {
        const l = live();
        l.deltas.set(itemId, (l.deltas.get(itemId) ?? "") + text);
        l.flush ??= setTimeout(() => this.flushDeltas(threadId), DELTA_FLUSH_MS);
      },
      sessionId: (id: string) => this.store.setSession(threadId, provider, { id }),
      usage: (used: number, window: number) => {
        this.store.setContext(threadId, { used, window });
        this.emitThread(threadId);
      },
      turnEnd: () => {
        const l = live();
        this.flushDeltas(threadId);
        this.store.setSession(threadId, provider, { seen: this.store.items(threadId).length });
        l.status = "idle";
        l.lastActive = Date.now();
        this.store.touch(threadId);
        this.emitThread(threadId);
        this.drain(threadId);
      },
      closed: (error?: string) => {
        const l = this.live.get(threadId);
        if (!l || l.session !== self()) return; // a replaced session shutting down
        this.flushDeltas(threadId);
        l.streaming.clear();
        l.session = undefined;
        if (error) {
          const item: Item = { id: crypto.randomUUID(), kind: "error", text: error, ts: Date.now() };
          this.store.appendItem(threadId, item);
          this.broadcast({ type: "item", threadId, item });
        }
        if (l.status === "running") {
          l.status = error ? "error" : "idle";
          this.emitThread(threadId);
        }
      },
      approve: (tool: string, input: unknown, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          const request: ApprovalRequest = { id: crypto.randomUUID(), threadId, provider, tool, input };
          this.approvals.set(request.id, { request, resolve });
          signal.addEventListener("abort", () => this.answer(request.id, false), { once: true });
          this.broadcast({ type: "approval", request });
        }),
      ask: (questions: Question[]) => {
        this.store.setQuestions(threadId, questions);
        this.emitThread(threadId);
      },
      todo: (todos) => {
        this.store.setTodos(threadId, todos);
        this.emitThread(threadId);
      },
    };
  }

  private drain(threadId: string) {
    const live = this.state(threadId);
    const next = live.queue.shift();
    if (!next) return;
    this.emitQueue(threadId);
    this.deliver(threadId, next);
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
      live = { status: "idle", queue: [], streaming: new Map(), deltas: new Map(), lastActive: Date.now() };
      this.live.set(threadId, live);
    }
    return live;
  }

  private withStatus(t: Thread): Thread {
    return { ...t, status: this.live.get(t.id)?.status ?? "idle" };
  }

  private emitThread(threadId: string): Thread {
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread.upserted", thread });
    return thread;
  }

  private emitQueue(threadId: string) {
    this.broadcast({ type: "queue", threadId, queue: this.state(threadId).queue });
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
