// Claude adapter: one long-lived `claude` process per active thread, fed through streaming input.
// Maps SDK messages onto provider-neutral transcript items.

import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, Command, Item, ModelOption } from "../shared/protocol";
import { agentDescription, ASKED, systemPrompt, TOOLS } from "./prompt";
import type { AgentSession, SessionEvents, SessionOptions, Steered } from "./session";
import { SURFACE_TOOLS } from "./surfaces";

// Built-in tools Tack keeps. Everything else (scheduling, cron, worktrees, notifications, review
// reporting, ...) is for other Claude Code surfaces and only costs context here. Sub-agents are
// Tack's own `agent` tool, which can run any provider and shows each one as a thread.
const BUILTIN_TOOLS = ["Bash", "Read", "Edit", "Write", "Skill", "WebFetch", "WebSearch", "ToolSearch"];

// Tack's tools, served in-process. The model sees them as mcp__tack__<name>.
// Children can ask and delegate too; closing summaries still go to their parent as plain text.
// Alignment and closing tools stay loaded; the rest can be discovered through ToolSearch.
function tackTools(events: SessionEvents, opts: SessionOptions) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;
  const scope = crypto.randomUUID();
  const keyOf = (extra: unknown) => {
    const request = extra as { requestId?: string | number; _meta?: Record<string, unknown> } | undefined;
    const id = request?._meta?.["claudecode/toolUseId"] ?? request?._meta?.toolUseId ?? request?.requestId;
    return `${scope}:${typeof id === "string" || typeof id === "number" ? id : crypto.randomUUID()}`;
  };
  return createSdkMcpServer({
    name: "tack",
    tools: [
      tool("ask", TOOLS.ask.description, TOOLS.ask.input, async ({ questions }) => {
        events.ask(questions);
        return text(ASKED);
      }, { alwaysLoad: true }),
      ...(opts.agentModels?.length
        ? [
            tool("agent", agentDescription(opts.agentModels), TOOLS.agent.input, async (input, extra) => text(await events.agent("agent", input, signalOf(extra), keyOf(extra))), {
              searchHint: "start a sub-agent, delegate work in parallel",
            }),
            tool("agent_status", TOOLS.agent_status.description, TOOLS.agent_status.input, async (input, extra) => text(await events.agent("agent_status", input, signalOf(extra), keyOf(extra))), {
              searchHint: "read a sub-agent's status or result, wait for it",
            }),
            tool("agent_send", TOOLS.agent_send.description, TOOLS.agent_send.input, async (input, extra) => text(await events.agent("agent_send", input, signalOf(extra), keyOf(extra))), {
              searchHint: "message a sub-agent, follow up, steer it",
            }),
            tool("agent_cancel", TOOLS.agent_cancel.description, TOOLS.agent_cancel.input, async (input, extra) => text(await events.agent("agent_cancel", input, signalOf(extra), keyOf(extra))), {
              searchHint: "stop a sub-agent",
            }),
          ]
        : []),
      ...(opts.role === "agent"
        ? []
        : [tool("wrap_up", TOOLS.wrap_up.description, TOOLS.wrap_up.input, async () => text("Shown to the user."), { alwaysLoad: true })]),
      ...Object.entries(SURFACE_TOOLS).map(([name, definition]) => tool(name, definition.description, definition.input,
        async (input, extra) => events.surface(name, input, signalOf(extra)),
        { searchHint: name.startsWith("preview_") ? "isolated browser testing, screenshot, navigate, click, type" : "visualize, interactive visual, chart, diagram, canvas, HTML preview" },
      )),
    ],
  });
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private wake?: () => void;
  private done = false;

  push(msg: SDKUserMessage) {
    this.buffer.push(msg);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.buffer.length) yield this.buffer.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

interface OpenBlock {
  item: Item;
  json?: string; // accumulated tool input
  shown: boolean; // thinking is only shown once it has text (it is often redacted)
}

export class ClaudeSession implements AgentSession {
  readonly provider = "claude";
  private inbox = new Inbox();
  private q: Query;
  private abort = new AbortController();
  private open = new Map<number, OpenBlock>();
  private tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  private streamed = new Set<string>(); // message ids already received via stream events
  private messageId = "";
  private turnStart = 0;
  private turnStarted = false;
  private interrupted = false;
  private prompt = 0; // tokens sent in the latest request, cache included
  private context = 0; // ...plus what the model wrote back
  closed = false;

  constructor(opts: SessionOptions, private events: SessionEvents) {
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        effort: opts.effort === "ultra" ? "max" : opts.effort, // Codex-only level
        resume: opts.resume,
        pathToClaudeCodeExecutable: opts.bin,
        // Background shell tasks report back through tools Tack leaves out, so their output would be lost.
        // claude.ai connectors (Linear, Docs, ...) load after the first request and add ~44k tokens of tool
        // definitions to every request after it. Tack has no UI for them, so they stay off.
        env: { ...opts.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" },
        abortController: this.abort,
        includePartialMessages: true,
        systemPrompt: systemPrompt("claude", opts.role),
        tools: BUILTIN_TOOLS,
        mcpServers: { tack: tackTools(events, opts) },
        hooks: {
          // wrap_up is the last call of a turn; skip the model request that would only say "done".
          PostToolUse: [{ matcher: "mcp__tack__wrap_up", hooks: [async () => ({ continue: false })] }],
        },
        skills: opts.skills ?? "all",
        title: "Tack", // Tack names threads itself; skips Claude's title-generation request
        permissionMode: opts.access === "full" ? "bypassPermissions" : "default",
        // Flag settings outrank the user's own settings, so Tack's access toggle wins. Tack's prompt
        // already sets the writing style, so a configured output style would only repeat it.
        // The skill listing is ~3k tokens at the default 1536 chars per skill; 100 keeps name and gist (~1.2k).
        settings: { permissions: { defaultMode: opts.access === "full" ? "bypassPermissions" : "default" }, outputStyle: "default", skillListingMaxDescChars: 100 },
        allowDangerouslySkipPermissions: opts.access === "full",
        canUseTool:
          opts.access === "ask"
            ? async (tool, input, { signal }) =>
                tool.startsWith("mcp__tack__") || (await events.approve(tool, input, signal))
                  ? { behavior: "allow", updatedInput: input }
                  : { behavior: "deny", message: "The user denied this action." }
            : undefined,
      },
    });
    this.run();
  }

  send(text: string, attachments: Attachment[]) {
    this.turnStart = Date.now();
    this.turnStarted = false;
    this.push(text, attachments);
  }

  // A message pushed while a turn runs is folded into it at the next tool boundary; one that
  // lands after the last tool call starts a follow-up turn (the result says so).
  async steer(text: string, attachments: Attachment[]): Promise<Steered> {
    this.push(text, attachments);
    return "sent";
  }

  private push(text: string, attachments: Attachment[]) {
    const content: any[] = attachments.flatMap((a) => a.kind !== "image" ? [] : [{
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: a.data },
    }]);
    if (text) content.push({ type: "text", text });
    this.inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt() {
    this.interrupted = true;
    await this.q.interrupt().catch(() => {});
  }

  async setModel(model: string) {
    await this.q.setModel(model);
  }

  // Aliases (opus, sonnet, ...) always point at the current generation, so they're the
  // "latest" group, strongest first. "default" duplicates one of them and is dropped.
  async models(): Promise<ModelOption[]> {
    const list = (await this.q.supportedModels()).filter((m) => m.value !== "default");
    const rank = ["fable", "opus", "sonnet", "haiku"];
    const options = list.map((m): ModelOption => ({
      provider: "claude",
      value: m.value,
      label: m.displayName,
      description: m.description,
      efforts: m.supportedEffortLevels ?? [],
      group: m.value.startsWith("claude-") ? "more" : "latest",
    }));
    // Latest by tier; the rest newest first, by the version in their name.
    const version = (o: ModelOption) => Number(o.label.match(/[\d.]+$/)?.[0] ?? 0);
    return options.sort((a, b) =>
      a.group !== b.group
        ? a.group === "latest" ? -1 : 1
        : a.group === "latest" ? rank.indexOf(a.value) - rank.indexOf(b.value) : version(b) - version(a),
    );
  }

  async commands(): Promise<Command[]> {
    return (await this.q.supportedCommands()).map((c) => ({
      name: c.name,
      description: c.description,
      hint: c.argumentHint || undefined,
      kind: "command",
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.inbox.end();
    this.abort.abort();
  }

  private async run() {
    let error: string | undefined;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (e) {
      if (!this.abort.signal.aborted) error = e instanceof Error ? e.message : String(e);
    }
    this.closed = true;
    this.flushOpen();
    this.events.closed(error);
  }

  private handle(msg: SDKMessage) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.events.sessionId(msg.session_id);
        return;
      case "stream_event":
        if (msg.parent_tool_use_id === null) this.stream(msg.event as any);
        return;
      case "assistant":
        if (msg.parent_tool_use_id === null) this.assistant(msg.message as any);
        return;
      case "user":
        if (msg.parent_tool_use_id === null) this.toolResults(msg.message as any);
        return;
      case "rate_limit_event": {
        const l = (msg as any).rate_limit_info;
        const label = LIMIT_LABELS[l?.rateLimitType];
        if (label && typeof l.utilization === "number") {
          // Utilization arrives as a fraction; resetsAt in seconds.
          const percent = Math.round((l.utilization <= 1 ? l.utilization * 100 : l.utilization) * 10) / 10;
          this.events.limits([{ kind: l.rateLimitType, label, percent, resetsAt: l.resetsAt ? l.resetsAt * 1000 : undefined }]);
        }
        return;
      }
      case "result": {
        this.turnStarted = false;
        this.flushOpen();
        const error = this.interrupted
          ? "Interrupted"
          : msg.subtype === "success"
            ? undefined
            : (msg as any).errors?.join("\n") || msg.subtype.replaceAll("_", " ");
        this.interrupted = false;
        const window = Math.max(0, ...Object.values((msg as any).modelUsage ?? {}).map((u: any) => u.contextWindow ?? 0));
        if (this.context && window) this.events.usage(this.context, window);
        this.events.item(
          { id: crypto.randomUUID(), kind: "turn", durationMs: Date.now() - (this.turnStart || Date.now()), error, ts: Date.now() },
          true,
        );
        // Sends that arrived too late to fold in run as their own turn, with their own result.
        if (((msg as any).queued_turn_count ?? 0) > 0) {
          this.turnStart = Date.now();
          return;
        }
        this.events.turnEnd();
        return;
      }
    }
  }

  private stream(ev: any) {
    switch (ev.type) {
      case "message_start": {
        this.started();
        this.messageId = ev.message.id;
        this.streamed.add(ev.message.id);
        const u = ev.message.usage ?? {};
        this.prompt = this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        return;
      }
      case "message_delta":
        this.context = this.prompt + (ev.usage?.output_tokens ?? 0); // cumulative per message
        return;
      case "content_block_start": {
        const b = ev.content_block;
        const ts = Date.now();
        let item: Item | undefined;
        if (b.type === "text") item = { id: `${this.messageId}:${ev.index}`, kind: "assistant", text: "", ts };
        else if (b.type === "thinking") item = { id: `${this.messageId}:${ev.index}`, kind: "thinking", text: "", ts };
        else if (b.type === "tool_use") item = { id: b.id, kind: "tool", name: b.name, input: {}, status: "running", ts };
        if (!item) return;
        const shown = item.kind !== "thinking";
        this.open.set(ev.index, { item, json: item.kind === "tool" ? "" : undefined, shown });
        if (shown) this.events.item(item, false);
        return;
      }
      case "content_block_delta": {
        const open = this.open.get(ev.index);
        if (!open) return;
        const d = ev.delta;
        if (d.type === "text_delta" || d.type === "thinking_delta") {
          const text = d.text ?? d.thinking ?? "";
          (open.item as { text: string }).text += text;
          if (!open.shown) {
            if (!(open.item as { text: string }).text.trim()) return;
            open.shown = true;
            this.events.item({ ...open.item }, false);
          } else this.events.delta(open.item.id, text);
        } else if (d.type === "input_json_delta") {
          open.json += d.partial_json;
        }
        return;
      }
      case "content_block_stop": {
        const open = this.open.get(ev.index);
        if (!open) return;
        this.open.delete(ev.index);
        this.finish(open);
        return;
      }
    }
  }

  private finish(open: OpenBlock) {
    const item = open.item;
    if (item.kind === "tool") {
      try {
        item.input = open.json ? JSON.parse(open.json) : {};
      } catch {
        item.input = { raw: open.json };
      }
      this.tools.set(item.id, item);
      this.events.item(item, false); // persisted once its result arrives
    } else if (item.kind === "thinking" && !item.text.trim()) {
      return; // redacted or empty thinking: nothing to show
    } else {
      this.events.item(item, true);
    }
  }

  private flushOpen() {
    for (const open of this.open.values()) this.finish(open);
    this.open.clear();
    // Tools that never got a result (interrupt, crash) are settled as errors.
    for (const tool of this.tools.values()) {
      if (tool.status !== "running") continue;
      tool.status = "error";
      tool.output ??= "Interrupted";
      this.events.item(tool, true);
    }
    this.tools.clear();
  }

  // Fallback for blocks that arrived without stream events.
  private assistant(message: { id: string; content: any[] }) {
    this.started();
    if (this.streamed.has(message.id)) return;
    message.content.forEach((b, i) => {
      const ts = Date.now();
      if (b.type === "text") this.events.item({ id: `${message.id}:${i}`, kind: "assistant", text: b.text, ts }, true);
      else if (b.type === "tool_use" && !this.tools.has(b.id)) {
        const item: Item = { id: b.id, kind: "tool", name: b.name, input: b.input, status: "running", ts };
        this.tools.set(b.id, item);
        this.events.item(item, false);
      }
    });
  }

  private started() {
    if (this.turnStarted) return;
    this.turnStarted = true;
    this.events.turnStart?.();
  }

  private toolResults(message: { content: unknown }) {
    if (!Array.isArray(message.content)) return;
    for (const b of message.content as any[]) {
      if (b.type !== "tool_result") continue;
      const tool = this.tools.get(b.tool_use_id);
      if (!tool) continue;
      tool.status = b.is_error ? "error" : "ok";
      tool.output = resultText(b.content).slice(0, MAX_OUTPUT);
      this.tools.delete(tool.id);
      this.events.item(tool, true);
    }
  }
}

// Tool output kept for display only; the model already has the full result.
const MAX_OUTPUT = 20_000;

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly, Opus",
  seven_day_sonnet: "Weekly, Sonnet",
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}
