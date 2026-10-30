// Codex adapter: one `codex app-server` process per active thread, JSON-RPC over stdio
// (one bare JSON object per line, no "jsonrpc" field). Maps thread items onto Tack items.

import type { Attachment, Command, Effort, Item, ModelOption, Todo } from "../shared/protocol";
import { ASKED, jsonSchema, systemPrompt, TOOLS, type AskInput } from "./prompt";
import type { AgentSession, SessionEvents, SessionOptions } from "./session";

type Json = any;

// Startup and account chatter we never use.
const QUIET = [
  "account/rateLimits/updated",
  "account/updated",
  "mcpServer/startupStatus/updated",
  "hook/started",
  "hook/completed",
  "remoteControl/status/changed",
  "thread/status/changed",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryPartAdded",
];

// Codex config Tack overrides for its own threads (the user's config.toml is left alone).
const config = (codexHome: string) => [
  "agents.enabled=false", // sub-agent tools and their instructions
  "tools.experimental_request_user_input.enabled=false", // replaced by Tack's `ask`
  "tools.update_plan.enabled=true", // shown as the task list
  "include_collaboration_mode_instructions=false",
  "features.goals=false",
  "features.tool_suggest=false",
  "features.apps=false",
  `skills.config=[{path=${JSON.stringify(`${codexHome}/skills/.system/skill-installer/SKILL.md`)},enabled=false}]`,
];

// Plugins whose skills and tools are for documents and office apps, not code. `visualize` is
// replaced by Tack's `show`.
const DISABLED_PLUGINS = [
  "documents@openai-primary-runtime",
  "pdf@openai-primary-runtime",
  "spreadsheets@openai-primary-runtime",
  "presentations@openai-primary-runtime",
  "template-creator@openai-primary-runtime",
  "google-calendar@openai-curated",
  "slack@openai-curated",
  "visualize@openai-bundled",
];

const DYNAMIC_TOOLS = (["ask", "show"] as const).map((name) => ({
  type: "function",
  name,
  description: TOOLS[name].description,
  inputSchema: jsonSchema(name),
}));

class Rpc {
  private proc: ReturnType<typeof Bun.spawn>;
  private next = 1;
  private pending = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();
  private stderr = "";
  exited: Promise<string | undefined>;

  constructor(
    bin: string,
    cwd: string,
    env: Record<string, string>,
    private onNotify: (method: string, params: Json) => void,
    private onRequest: (method: string, params: Json) => Promise<Json>,
  ) {
    const args = config(env.CODEX_HOME ?? `${env.HOME}/.codex`).flatMap((c) => ["-c", c]);
    this.proc = Bun.spawn([bin, "app-server", ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read(this.proc.stdout as ReadableStream<Uint8Array>, (line) => this.handle(line));
    this.read(this.proc.stderr as ReadableStream<Uint8Array>, (line) => (this.stderr = (this.stderr + line + "\n").slice(-2000)));
    this.exited = this.proc.exited.then((code) => {
      for (const p of this.pending.values()) p.reject(new Error("Codex exited"));
      this.pending.clear();
      return code === 0 || code === null ? undefined : this.stderr.trim().split("\n").pop() || `Codex exited with code ${code}`;
    });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json) {
    this.write(params === undefined ? { method } : { method, params });
  }

  kill() {
    this.proc.kill();
  }

  private write(frame: Json) {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(frame) + "\n");
    stdin.flush();
  }

  private async handle(line: string) {
    let frame: Json;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.method && frame.id !== undefined) {
      try {
        this.write({ id: frame.id, result: await this.onRequest(frame.method, frame.params) });
      } catch (e) {
        this.write({ id: frame.id, error: { code: -32601, message: e instanceof Error ? e.message : String(e) } });
      }
    } else if (frame.method) {
      this.onNotify(frame.method, frame.params);
    } else {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error.message ?? "Codex request failed"));
      else p.resolve(frame.result);
    }
  }

  private async read(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
  }
}

type Tool = Extract<Item, { kind: "tool" }>;

export class CodexSession implements AgentSession {
  readonly provider = "codex";
  private rpc: Rpc;
  private init: Promise<void>;
  private thread?: Promise<string>;
  private turnId?: string;
  private turnStart = 0;
  private interrupted = false;
  private approvals = new AbortController();
  private open = new Map<string, Item>(); // items started but not completed
  private shown = new Set<string>(); // thinking is only shown once it has text
  private skills = new Map<string, string>(); // name -> path
  private model: string;
  private effort: Effort;
  closed = false;

  constructor(private opts: SessionOptions, private events: SessionEvents) {
    this.model = opts.model;
    this.effort = opts.effort;
    if (!opts.bin) throw new Error("`codex` not found on PATH");
    this.rpc = new Rpc(opts.bin, opts.cwd, opts.env, (m, p) => this.notification(m, p), (m, p) => this.serverRequest(m, p));
    this.init = this.rpc
      .request("initialize", {
        clientInfo: { name: "tack", title: "Tack", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: QUIET },
      })
      .then(() => this.rpc.notify("initialized"));
    this.init.catch(() => {});
    this.rpc.exited.then((error) => {
      const wasClosed = this.closed;
      this.closed = true;
      this.flushOpen();
      this.events.closed(wasClosed ? undefined : error);
    });
  }

  send(text: string, attachments: Attachment[]) {
    this.turnStart = Date.now();
    this.interrupted = false;
    this.run(text, attachments).catch((e) => {
      this.events.item({ id: crypto.randomUUID(), kind: "error", text: e.message, ts: Date.now() }, true);
      this.events.turnEnd();
    });
  }

  async interrupt() {
    this.interrupted = true;
    if (!this.thread || !this.turnId) return;
    const threadId = await this.thread;
    await this.rpc.request("turn/interrupt", { threadId, turnId: this.turnId }).catch(() => {});
  }

  async setModel(model: string) {
    this.model = model; // applies from the next turn
  }

  async models(): Promise<ModelOption[]> {
    await this.init;
    const { data } = await this.rpc.request("model/list", {});
    const visible = (data as Json[]).filter((m) => !m.hidden);
    const major = (m: Json) => Number(String(m.model ?? m.id).match(/(\d+)(?:\.\d+)?/)?.[1] ?? 0);
    const newest = Math.max(...visible.map(major));
    return visible.map((m) => ({
      provider: "codex",
      value: m.model ?? m.id,
      label: m.displayName ?? m.id,
      description: m.description ?? "",
      efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => e.reasoningEffort).filter(isEffort),
      group: major(m) === newest ? "latest" : "more",
    }));
  }

  async commands(): Promise<Command[]> {
    await this.init;
    const { data } = await this.rpc.request("skills/list", { cwds: [this.opts.cwd] });
    const skills = ((data as Json[])[0]?.skills ?? []).filter((s: Json) => s.enabled !== false);
    for (const s of skills) this.skills.set(s.name, s.path);
    return skills.map((s: Json) => ({ name: s.name, description: s.shortDescription || s.description || "", kind: "skill" }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.approvals.abort();
    this.rpc.kill();
  }

  // ---- internals

  private policy() {
    return this.opts.access === "full"
      ? { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } }
      : { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: undefined };
  }

  private startThread(): Promise<string> {
    const { approvalPolicy, sandbox } = this.policy();
    const base = { cwd: this.opts.cwd, model: this.model, approvalPolicy, sandbox, baseInstructions: systemPrompt("codex") };
    return (this.thread ??= (async () => {
      await this.init;
      let result: Json;
      if (this.opts.resume) {
        result = await this.rpc
          .request("thread/resume", { threadId: this.opts.resume, excludeTurns: true, ...base })
          .catch(() => undefined);
      }
      // Dynamic tools are stored with the thread, so only a new thread declares them.
      result ??= await this.rpc.request("thread/start", { ...base, dynamicTools: DYNAMIC_TOOLS });
      this.events.sessionId(result.thread.id);
      return result.thread.id as string;
    })());
  }

  private async run(text: string, attachments: Attachment[]) {
    const threadId = await this.startThread();
    const input: Json[] = [];
    // "/skill rest" invokes a skill: Codex wants the skill item plus "$skill" in the text.
    const skill = text.match(/^\/([\w:.-]+)(\s|$)/);
    if (skill) {
      if (!this.skills.size) await this.commands().catch(() => {});
      const path = this.skills.get(skill[1]!);
      if (path) {
        input.push({ type: "skill", name: skill[1], path });
        text = `$${text.slice(1)}`;
      }
    }
    for (const a of attachments) {
      if (a.kind === "image") input.push({ type: "image", url: `data:${a.mediaType};base64,${a.data}` });
    }
    input.unshift({ type: "text", text, text_elements: [] });
    const { approvalPolicy, sandboxPolicy } = this.policy();
    this.approvals = new AbortController();
    const { turn } = await this.rpc.request("turn/start", {
      threadId,
      input,
      model: this.model,
      effort: this.effort,
      approvalPolicy,
      disabledPluginIds: DISABLED_PLUGINS,
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    });
    this.turnId = turn.id;
  }

  private notification(method: string, p: Json) {
    switch (method) {
      case "turn/started":
        this.turnId = p.turn.id;
        return;
      case "item/started": {
        const item = toItem(p.item, false);
        if (!item) return;
        this.open.set(item.id, item);
        if (item.kind !== "thinking") this.events.item(item, false);
        return;
      }
      case "item/agentMessage/delta":
        return this.text(p.itemId, p.delta);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.text(p.itemId, p.delta);
      case "item/commandExecution/outputDelta": {
        const tool = this.open.get(p.itemId);
        if (tool?.kind === "tool") tool.output = ((tool.output ?? "") + p.delta).slice(-MAX_OUTPUT);
        return;
      }
      case "item/completed": {
        const item = toItem(p.item, true);
        this.open.delete(p.item.id);
        this.shown.delete(p.item.id);
        if (!item || (item.kind === "thinking" && !item.text.trim())) return;
        this.events.item(item, true);
        return;
      }
      case "turn/plan/updated":
        return this.events.todo(
          (p.plan as Json[]).map((s): Todo => ({
            content: s.step,
            status: s.status === "inProgress" ? "in_progress" : s.status,
          })),
        );
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage;
        if (u?.modelContextWindow) this.events.usage(u.last?.totalTokens ?? 0, u.modelContextWindow);
        return;
      }
      case "turn/completed": {
        this.flushOpen();
        this.approvals.abort();
        const t = p.turn;
        const error =
          t.status === "interrupted" || this.interrupted
            ? "Interrupted"
            : t.status === "failed"
              ? t.error?.message || "Turn failed"
              : undefined;
        this.interrupted = false;
        this.turnId = undefined;
        this.events.item(
          { id: crypto.randomUUID(), kind: "turn", durationMs: t.durationMs ?? Date.now() - this.turnStart, error, ts: Date.now() },
          true,
        );
        this.events.turnEnd();
        return;
      }
    }
  }

  // Streamed text for an assistant message or thinking block.
  private text(itemId: string, delta: string) {
    const item = this.open.get(itemId);
    if (!item || (item.kind !== "assistant" && item.kind !== "thinking")) return;
    item.text += delta;
    if (item.kind === "assistant" || this.shown.has(itemId)) return this.events.delta(itemId, delta);
    if (!item.text.trim()) return;
    this.shown.add(itemId);
    this.events.item({ ...item }, false);
  }

  private async serverRequest(method: string, p: Json): Promise<Json> {
    const ask = (tool: string, input: unknown) => this.events.approve(tool, input, this.approvals.signal);
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const allow = await ask("Bash", { command: unwrap(Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? "")), cwd: p.cwd, description: p.reason });
        return { decision: allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const item = this.open.get(p.itemId);
        const allow = await ask("Patch", item?.kind === "tool" ? item.input : { reason: p.reason });
        return { decision: allow ? "accept" : "decline" };
      }
      case "item/tool/call": {
        const text = (t: string) => ({ contentItems: [{ type: "inputText", text: t }], success: true });
        if (p.tool === "ask") {
          this.events.ask((p.arguments as AskInput).questions);
          return text(ASKED);
        }
        if (p.tool === "show") return text("Shown to the user above your reply.");
        return { contentItems: [{ type: "inputText", text: `Unknown tool ${p.tool}` }], success: false };
      }
      default:
        throw new Error(`Tack does not support ${method}`);
    }
  }

  private flushOpen() {
    for (const item of this.open.values()) {
      if (item.kind === "tool" && item.status === "running") {
        item.status = "error";
        item.output ||= "Interrupted";
        this.events.item(item, true);
      } else if (item.kind === "assistant" && item.text) this.events.item(item, true);
    }
    this.open.clear();
    this.shown.clear();
  }
}

// Tool output kept for display only; the model already has the full result.
const MAX_OUTPUT = 20_000;
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max", "ultra"]);
const isEffort = (e: string): e is Effort => EFFORTS.has(e);

function toItem(t: Json, done: boolean): Item | undefined {
  const ts = t.startedAtMs ?? Date.now();
  const status = (ok: boolean): Tool["status"] => (!done ? "running" : ok ? "ok" : "error");
  switch (t.type) {
    case "agentMessage":
      return { id: t.id, kind: "assistant", text: t.text ?? "", ts };
    case "reasoning":
      return { id: t.id, kind: "thinking", text: (t.summary?.length ? t.summary : (t.content ?? [])).join("\n\n"), ts };
    case "commandExecution":
      return {
        id: t.id,
        kind: "tool",
        name: "Bash",
        input: { command: unwrap(Array.isArray(t.command) ? t.command.join(" ") : String(t.command ?? "")) },
        output: t.status === "declined" ? "Declined" : (t.aggregatedOutput ?? undefined)?.slice(-MAX_OUTPUT),
        status: status(t.status === "completed" && (t.exitCode ?? 0) === 0),
        ts,
      };
    case "fileChange":
      return {
        id: t.id,
        kind: "tool",
        name: "Patch",
        input: { changes: (t.changes ?? []).map((c: Json) => ({ path: c.path, kind: c.kind?.type, diff: c.diff })) },
        output: t.status === "declined" ? "Declined" : undefined,
        status: status(t.status === "completed"),
        ts,
      };
    case "mcpToolCall":
      return {
        id: t.id,
        kind: "tool",
        name: `mcp__${t.server}__${t.tool}`,
        input: t.arguments ?? {},
        output: t.error?.message ?? mcpText(t.result),
        status: status(!t.error && t.status !== "failed"),
        ts,
      };
    case "dynamicToolCall":
      return {
        id: t.id,
        kind: "tool",
        name: t.tool,
        input: t.arguments ?? {},
        output: (t.contentItems as Json[] | undefined)?.map((c) => c.text ?? "").join("\n") || undefined,
        status: status(t.success !== false),
        ts,
      };
    case "webSearch":
      return { id: t.id, kind: "tool", name: "WebSearch", input: { query: t.query }, status: status(true), ts };
    case "imageView":
      return { id: t.id, kind: "tool", name: "Read", input: { file_path: t.path }, status: status(true), ts };
    default:
      return undefined;
  }
}

// Codex runs everything as `/bin/zsh -lc '...'` (or "..."); show the command itself.
function unwrap(command: string): string {
  const single = command.match(/^\S*\/(?:z|ba)?sh -lc '([\s\S]*)'$/);
  if (single) return single[1]!.replaceAll("'\\''", "'");
  const double = command.match(/^\S*\/(?:z|ba)?sh -lc "([\s\S]*)"$/);
  return double ? double[1]!.replace(/"'(.*?)'"/g, "$1").replace(/\\(["\\$`])/g, "$1") : command;
}

function mcpText(result: Json): string | undefined {
  if (!result?.content) return undefined;
  return (result.content as Json[])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n")
    .slice(0, MAX_OUTPUT);
}
