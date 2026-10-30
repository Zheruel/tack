// Claude adapter: one long-lived `claude` process per active thread, fed through streaming input.
// Maps SDK messages onto provider-neutral transcript items.

import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, Command, Item, ModelOption, Todo } from "../shared/protocol";
import { agentDescription, applyTodo, ASKED, systemPrompt, TOOLS } from "./prompt";
import type { AgentSession, SessionEvents, SessionOptions } from "./session";

// Built-in tools Tack keeps. Everything else (scheduling, cron, worktrees, notifications, review
// reporting, ...) is for other Claude Code surfaces and only costs context here. Sub-agents are
// Tack's own `agent` tool, which can run any provider and shows each one as a thread.
const BUILTIN_TOOLS = ["Bash", "Read", "Edit", "Write", "Skill", "WebFetch", "WebSearch"];

// ask / todo / show / agent, served in-process. The model sees them as mcp__tack__<name>.
// A sub-agent gets neither ask (nobody to ask) nor agent (one level deep).
function tackTools(events: SessionEvents, opts: SessionOptions) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  let todos: Todo[] = [];
  return createSdkMcpServer({
    name: "tack",
    alwaysLoad: true,
    tools: [
      ...(opts.role === "agent"
        ? []
        : [
            tool("ask", TOOLS.ask.description, TOOLS.ask.input, async ({ questions }) => {
              events.ask(questions);
              return text(ASKED);
            }),
          ]),
      ...(opts.agentModels?.length
        ? [tool("agent", agentDescription(opts.agentModels), TOOLS.agent.input, async (input) => text(events.agent(input)))]
        : []),
      tool("todo", TOOLS.todo.description, TOOLS.todo.input, async (input) => {
        todos = applyTodo(todos, input);
        events.todo(todos);
        const current = todos.findIndex((t) => t.status === "in_progress");
        return text(current < 0 ? "All steps done." : `Step ${current + 1} of ${todos.length} in progress.`);
      }),
      tool("show", TOOLS.show.description, TOOLS.show.input, async () => text("Shown to the user above your reply.")),
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
        env: { ...opts.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
        abortController: this.abort,
        includePartialMessages: true,
        systemPrompt: systemPrompt("claude", opts.role),
        tools: BUILTIN_TOOLS,
        mcpServers: { tack: tackTools(events, opts) },
        skills: opts.skills ?? "all",
        title: "Tack", // Tack names threads itself; skips Claude's title-generation request
        permissionMode: opts.access === "full" ? "bypassPermissions" : "default",
        // Flag settings outrank the user's own settings, so Tack's access toggle wins. Tack's prompt
        // already sets the writing style, so a configured output style would only repeat it.
        settings: { permissions: { defaultMode: opts.access === "full" ? "bypassPermissions" : "default" }, outputStyle: "default" },
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
    const content: any[] = attachments.flatMap((a) => a.kind !== "image" ? [] : [{
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: a.data },
    }]);
    if (text) content.push({ type: "text", text });
    this.turnStart = Date.now();
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
      case "result": {
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
        this.events.turnEnd();
        return;
      }
    }
  }

  private stream(ev: any) {
    switch (ev.type) {
      case "message_start": {
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

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}
