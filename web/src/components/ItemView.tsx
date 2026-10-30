import { createCodePlugin } from "@streamdown/code";
import { Check, ChevronRight, Copy, Image as ImageIcon, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Streamdown } from "streamdown";
import type { Item } from "../../../shared/protocol";
import { useApp } from "../store";
import { ProviderLogo } from "./Logos";
import { AgentCard, Asked, tackTool, Visual } from "./TackTools";

const plugins = { code: createCodePlugin({ themes: ["github-light", "vitesse-dark"] }) };
const controls = { code: { copy: true, download: false }, table: false };

type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;
type Tool = Of<"tool">;

export function ItemView({ threadId, item, streaming }: { threadId: string; item: Item; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return item.agents ? <AgentReports item={item} /> : <UserMessage item={item} />;
    case "assistant":
      return <Markdown text={item.text} streaming={streaming} />;
    case "turn":
      return <TurnEnd threadId={threadId} item={item} />;
    case "handoff":
      return <Handoff item={item} />;
    case "tool": {
      const own = tackTool(item.name); // the rest render inside <Steps>
      if (own === "agent") return <AgentCard tool={item} threadId={threadId} />;
      return own === "show" ? <Visual tool={item} /> : own === "ask" ? <Asked tool={item} /> : null;
    }
    case "error":
      return (
        <div className="selectable my-3 rounded-xl border border-danger/25 bg-danger/[0.06] px-4 py-3 text-[13.5px] leading-relaxed text-danger">
          {item.text}
        </div>
      );
    default:
      return null; // tools and thinking render inside <Steps>
  }
}

function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="prose-tack selectable py-2">
      <Streamdown
        plugins={plugins}
        controls={controls}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
        isAnimating={streaming}
        caret={streaming ? "block" : undefined}
        shikiTheme={["github-light", "vitesse-dark"]}
      >
        {text}
      </Streamdown>
    </div>
  );
}

const AGENT = { claude: "Claude", codex: "Codex" } as const;

// A quiet divider where the thread moved to another agent.
function Handoff({ item }: { item: Of<"handoff"> }) {
  return (
    <div className="flex items-center gap-3 pt-7 pb-1 text-[12px] text-faint">
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5">
        <ProviderLogo provider={item.to} className="size-3" />
        Switched to {AGENT[item.to]}
        <span className="text-faint/70">
          with {item.carried} {item.carried === 1 ? "entry" : "entries"} of context from {AGENT[item.from]}
        </span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// Sub-agents' reports, which Tack sends the agent as a message. Folded: the agent's reply says
// what matters, and each sub-agent's thread has the full story.
function AgentReports({ item }: { item: Of<"user"> }) {
  const [open, setOpen] = useState(false);
  const body = item.text.replace(/^<agent-reports>\n/, "").replace(/\n<\/agent-reports>[\s\S]*$/, "");
  const count = body.match(/^## /gm)?.length ?? 1;
  return (
    <div className="pt-5 pb-1">
      <button onClick={() => setOpen(!open)} className="flex h-6 items-center gap-2 text-[13px] text-faint hover:text-dim">
        <Check size={13} className="text-ok/80" />
        {count === 1 ? "Agent reported back" : `${count} agents reported back`}
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 border-l border-line pl-4 text-[13.5px] text-dim">
          <Markdown text={body} streaming={false} />
        </div>
      )}
    </div>
  );
}

function UserMessage({ item }: { item: Of<"user"> }) {
  const command = item.text.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  return (
    <div className="flex justify-end pt-7 pb-3 first:pt-1">
      <div className="max-w-[80%] rounded-[18px] bg-raised px-4 py-2.5 ring-1 ring-line/60">
        {item.attachments && item.attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {item.attachments.map((a, i) => (
              <span key={i} className="flex items-center gap-1 text-[12px] text-dim">
                {a.image ? <ImageIcon size={12} /> : <Paperclip size={12} />}
                {a.name}
              </span>
            ))}
          </div>
        )}
        {command ? (
          <p className="selectable text-[14.5px] leading-[1.6] tracking-[-0.003em] whitespace-pre-wrap text-ink">
            <span className="mr-1.5 inline-flex items-center rounded-md bg-brass/15 px-1.5 py-px align-[1px] font-mono text-[12.5px] text-brass">
              /{command[1]}
            </span>
            {command[2]}
          </p>
        ) : (
          <p className="selectable text-[14.5px] leading-[1.6] tracking-[-0.003em] whitespace-pre-wrap text-ink">
            {withMentions(item.text)}
          </p>
        )}
      </div>
    </div>
  );
}

// "@path" mentions read as file chips.
function withMentions(text: string): React.ReactNode {
  const parts = text.split(/((?:^|(?<=\s))@[^\s@]+)/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <span key={i} className="rounded-md bg-hover px-1 py-px font-mono text-[12.5px] text-ink/90" title={p.slice(1)}>
        {p.slice(1).split("/").pop()}
      </span>
    ) : (
      p
    ),
  );
}

// ---- steps: a run of tool calls and thinking, collapsed to one quiet line. Narration carries
// the story; the details open on click. The run in progress shows in <LiveLine> instead.

export function Steps({ threadId, ids, live }: { threadId: string; ids: string[]; live: boolean }) {
  const items = useApp(useShallow((s) => ids.map((id) => s.transcripts[threadId]?.byId[id]).filter(Boolean) as Item[]));
  const [open, setOpen] = useState(false);
  const tools = items.filter((i): i is Tool => i.kind === "tool");
  const failed = tools.filter((t) => t.status === "error").length;

  // Thinking alone isn't worth a line.
  if (live || !tools.length) return null;

  return (
    <div className="py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex min-h-7 max-w-full items-center gap-1.5 text-left text-[13.5px] text-faint transition-colors hover:text-dim"
      >
        <Caret open={open} />
        <span className="truncate">{summarize(items)}</span>
        {failed > 0 && <span className="shrink-0 text-danger/80">, {failed} failed</span>}
      </button>
      <Unfold open={open}>
        <StepList items={items} />
      </Unfold>
    </div>
  );
}

function StepList({ items }: { items: Item[] }) {
  return (
    <div className="mt-0.5 mb-1.5 ml-[3px] border-l border-line pl-4">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolLine key={item.id} tool={item} live={false} />
        ) : item.kind === "thinking" ? (
          <ThinkingLine key={item.id} text={item.text} />
        ) : null,
      )}
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 8 8"
      aria-hidden
      className={`size-2.5 shrink-0 fill-current opacity-80 transition-transform duration-[250ms] ease-[cubic-bezier(.19,1,.22,1)] ${open ? "rotate-90" : ""}`}
    >
      <path d="M2.5 1.2 6.2 4 2.5 6.8z" />
    </svg>
  );
}

// Height animates open and closed.
function Unfold({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.19,1,.22,1)] ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <div className="min-h-0 overflow-hidden">{open && children}</div>
    </div>
  );
}

// What the agent is doing right now, pinned last in the transcript while a turn runs.
// One line by default; expanding shows this run's finished steps and the command's latest output.
export function LiveLine({ threadId }: { threadId: string }) {
  // A flat list so the shallow compare sees stable items: [turn start, ...trailing run].
  const [start, ...items] = useApp(
    useShallow((s): [number | undefined, ...Item[]] => {
      const t = s.transcripts[threadId];
      const order = t?.order ?? [];
      let first = order.length;
      while (first > 0 && t!.byId[order[first - 1]!]?.kind !== "turn") first--;
      const startItem = order.slice(first).map((id) => t!.byId[id]).find((i) => i?.kind === "user");
      // The run of steps at the end of the transcript, if the agent is in one.
      const run: Item[] = [];
      for (let i = order.length - 1; i >= first; i--) {
        const item = t!.byId[order[i]!]!;
        if (item.kind !== "tool" && item.kind !== "thinking") {
          if (!run.length) run.push(item);
          break;
        }
        run.unshift(item);
      }
      return [startItem?.ts, ...run];
    }),
  );
  const [open, setOpen] = useState(false);
  const now = useNow();

  const current = items[items.length - 1];
  const steps = items.filter((i) => i.kind === "tool" || i.kind === "thinking");
  const finished = steps.slice(0, -1);
  // Always present tense: the last step stays current until the next item arrives.
  const { verb, target } =
    current?.kind === "tool" ? present(current, true) : current?.kind === "assistant" ? { verb: "Writing", target: undefined } : { verb: "Thinking", target: undefined };
  const output = current?.kind === "tool" ? current.output?.trimEnd().split("\n").slice(-4) : undefined;

  return (
    <div className="mt-2.5 select-none" aria-live="polite">
      <button onClick={() => setOpen(!open)} className="group flex h-8 max-w-full items-center gap-2.5 text-left text-[13.5px] text-dim">
        <TackPress />
        <span key={`${verb}${target}`} className="live-swap flex min-w-0 items-center gap-2">
          <span className="shimmer shrink-0">{verb}</span>
          {target && <span className="max-w-[44ch] truncate font-mono text-[12.5px] text-faint">{short(target)}</span>}
        </span>
        {start && <span className="shrink-0 text-[12.5px] text-faint tabular-nums">{elapsed(now - start)}</span>}
        <span className="text-faint group-hover:text-dim">
          <Caret open={open} />
        </span>
      </button>
      <Unfold open={open}>
        {finished.length > 0 && <StepList items={finished} />}
        {output?.length ? (
          <pre className="selectable mt-0.5 mb-1.5 ml-[26px] overflow-hidden font-mono text-[11.5px] leading-[1.65] whitespace-pre text-faint">
            {output.join("\n")}
          </pre>
        ) : (
          !finished.length && <p className="mb-1.5 ml-[26px] text-[12.5px] text-faint">Nothing finished in this step yet.</p>
        )}
      </Unfold>
    </div>
  );
}

// Tack's mark pressing in, with a ripple where the pin lands.
function TackPress() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 overflow-visible">
      <defs>
        <linearGradient id="tack-press" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e2c27e" />
          <stop offset="1" stopColor="#a9823f" />
        </linearGradient>
      </defs>
      <ellipse className="tack-ripple" cx="8" cy="14.6" rx="4" ry="1.3" fill="none" stroke="var(--color-brass)" strokeWidth="0.9" />
      <g className="tack-pin">
        <ellipse cx="8" cy="4.6" rx="5.2" ry="2.1" fill="url(#tack-press)" />
        <ellipse cx="8" cy="4.1" rx="4" ry="1.2" fill="#ecd39c" opacity="0.45" />
        <path d="M7.1 6.6h1.8l-.6 7.2q-.3.7-.6 0z" fill="url(#tack-press)" />
      </g>
    </svg>
  );
}

function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function Dot({ state }: { state: "running" | "error" | "done" }) {
  return (
    <span
      className={`size-[7px] shrink-0 rounded-full ${
        state === "running" ? "pulse bg-brass" : state === "error" ? "bg-danger/80" : "bg-faint/50"
      }`}
    />
  );
}

function ThinkingLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <button onClick={() => setOpen(!open)} className="flex h-6 items-center gap-2 text-[13px] text-faint hover:text-dim">
        Thought
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <p className="selectable mt-1 mb-2 text-[13px] leading-relaxed whitespace-pre-wrap text-dim italic">{text}</p>
      )}
    </div>
  );
}

function ToolLine({ tool, live }: { tool: Tool; live: boolean }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = present(tool);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="group flex h-7 max-w-full items-center gap-2 text-left text-[13.5px] text-dim hover:text-ink"
      >
        <Dot state={tool.status === "running" || live ? "running" : tool.status === "error" ? "error" : "done"} />
        <span className="shrink-0">{verb}</span>
        {target && <span className="truncate font-mono text-[12px] text-faint group-hover:text-dim">{target}</span>}
      </button>
      {open && <ToolDetail tool={tool} />}
    </div>
  );
}

function ToolDetail({ tool }: { tool: Tool }) {
  const input = tool.input as Record<string, any>;
  const isEdit = (tool.name === "Edit" || tool.name === "MultiEdit") && typeof input.old_string === "string";
  return (
    <div className="selectable mt-1 mb-2.5 overflow-hidden rounded-xl border border-line bg-rail font-mono text-[12px] leading-relaxed">
      {isEdit ? (
        <div className="max-h-80 overflow-auto py-2">
          {String(input.old_string).split("\n").map((l, i) => (
            <div key={`o${i}`} className="bg-danger/[0.07] px-3 whitespace-pre text-danger/90">
              - {l}
            </div>
          ))}
          {String(input.new_string ?? "").split("\n").map((l, i) => (
            <div key={`n${i}`} className="bg-ok/[0.07] px-3 whitespace-pre text-ok">
              + {l}
            </div>
          ))}
        </div>
      ) : tool.name === "Patch" && Array.isArray(input.changes) ? (
        <div className="max-h-96 overflow-auto py-1.5">
          {input.changes.map((c: { path: string; diff?: string }, ci: number) => (
            <div key={ci}>
              <div className="px-3 pt-1 pb-0.5 text-faint">{c.path}</div>
              {(c.diff ?? "")
                .split("\n")
                .filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
                .map((l, i) => (
                  <div
                    key={i}
                    className={`px-3 whitespace-pre ${
                      l.startsWith("+") ? "bg-ok/[0.07] text-ok" : l.startsWith("-") ? "bg-danger/[0.07] text-danger/90" : l.startsWith("@@") ? "text-faint" : "text-dim"
                    }`}
                  >
                    {l || " "}
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : tool.name === "Write" && typeof input.content === "string" ? (
        <pre className="max-h-72 overflow-auto px-3 py-2 whitespace-pre-wrap text-dim">{input.content}</pre>
      ) : (
        <pre className="max-h-60 overflow-auto px-3 py-2 whitespace-pre-wrap text-dim">
          {typeof input.command === "string" ? `$ ${input.command}` : JSON.stringify(input, null, 2)}
        </pre>
      )}
      {tool.output && (
        <pre
          className={`max-h-72 overflow-auto border-t border-line px-3 py-2 whitespace-pre-wrap ${
            tool.status === "error" ? "text-danger/90" : "text-faint"
          }`}
        >
          {tool.output}
        </pre>
      )}
    </div>
  );
}

const file = (p?: string) => (p ? p.split("/").slice(-2).join("/") : undefined);

// A command's gist: drops a leading "cd <dir> &&" and anything past the first pipe or chain.
function short(target: string) {
  return target.replace(/^cd\s+\S+\s*&&\s*/, "").split(/\s*(?:&&|\|\||;|\|)\s*/)[0]!;
}

function present(tool: Tool, live = false): { verb: string; target?: string } {
  const input = (tool.input ?? {}) as Record<string, any>;
  const running = live || tool.status === "running";
  const v = (doing: string, done: string) => (running ? doing : done);
  switch (tool.name) {
    case "Bash":
      return { verb: v("Running", "Ran"), target: input.description || input.command };
    case "Read":
      return { verb: v("Reading", "Read"), target: file(input.file_path) };
    case "Edit":
    case "MultiEdit":
      return { verb: v("Editing", "Edited"), target: file(input.file_path) };
    case "Write":
      return { verb: v("Writing", "Wrote"), target: file(input.file_path) };
    case "Patch": {
      const paths: string[] = (input.changes ?? []).map((c: { path: string }) => c.path);
      return { verb: v("Editing", "Edited"), target: paths.length > 1 ? `${paths.length} files` : file(paths[0]) };
    }
    case "Grep":
      return { verb: v("Searching", "Searched"), target: input.pattern };
    case "Glob":
      return { verb: v("Finding files", "Found files"), target: input.pattern };
    case "WebFetch":
      return { verb: v("Fetching", "Fetched"), target: input.url };
    case "WebSearch":
      return { verb: v("Searching the web", "Searched the web"), target: input.query };
    case "TodoWrite":
      return { verb: v("Updating the plan", "Updated the plan") };
    case "update_plan":
      return { verb: v("Updating the plan", "Updated the plan") };
    case "Task":
    case "Agent":
      return { verb: v("Delegating", "Delegated"), target: input.description };
    default:
      return { verb: tool.name.replace(/^mcp__/, "").replaceAll("__", " ") };
  }
}

// "Read server.ts, edited 2 files and ran 3 commands". A lone file is named.
function summarize(items: Item[]): string {
  const files = { read: new Set<string>(), write: new Set<string>(), edit: new Set<string>() };
  const count = { search: 0, run: 0, web: 0, other: 0 };
  for (const i of items) {
    if (i.kind !== "tool") continue;
    const input = (i.input ?? {}) as Record<string, any>;
    const path = typeof input.file_path === "string" ? input.file_path : undefined;
    if (i.name === "Read") files.read.add(path ?? i.id);
    else if (i.name === "Grep" || i.name === "Glob") count.search++;
    else if (i.name === "Write") files.write.add(path ?? i.id);
    else if (i.name === "Edit" || i.name === "MultiEdit") files.edit.add(path ?? i.id);
    else if (i.name === "Patch") for (const c of input.changes ?? [{ path: i.id }]) files.edit.add(c.path);
    else if (i.name === "Bash") count.run++;
    else if (i.name === "WebFetch" || i.name === "WebSearch") count.web++;
    else count.other++;
  }
  const named = (set: Set<string>, verb: string) => {
    if (!set.size) return undefined;
    const [only] = set;
    return set.size === 1 && only!.includes("/") ? `${verb} ${only!.split("/").pop()}` : `${verb} ${set.size} ${set.size === 1 ? "file" : "files"}`;
  };
  const n = (k: number, text: string) => (k ? text : undefined);
  const parts = [
    named(files.read, "read"),
    n(count.search, count.search === 1 ? "searched once" : `searched ${count.search} times`),
    named(files.write, "wrote"),
    named(files.edit, "edited"),
    n(count.run, count.run === 1 ? "ran a command" : `ran ${count.run} commands`),
    n(count.web, count.web === 1 ? "browsed a page" : `browsed ${count.web} pages`),
    n(count.other, count.other === 1 ? "used a tool" : `used ${count.other} tools`),
  ].filter(Boolean) as string[];
  if (!parts.length) return "Thought";
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return text[0]!.toUpperCase() + text.slice(1);
}

function TurnEnd({ threadId, item }: { threadId: string; item: Of<"turn"> }) {
  const [copied, setCopied] = useState(false);
  const s = item.durationMs / 1000;
  const took = s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;

  // Copy the turn's final answer: the assistant text just before this marker.
  const copy = () => {
    const t = useApp.getState().transcripts[threadId];
    if (!t) return;
    const parts: string[] = [];
    for (let i = t.order.indexOf(item.id) - 1; i >= 0; i--) {
      const it = t.byId[t.order[i]!]!;
      if (it.kind === "user" || it.kind === "turn") break;
      if (it.kind === "assistant") parts.unshift(it.text);
    }
    navigator.clipboard.writeText(parts.join("\n\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group flex h-7 items-center gap-3 text-[12px] text-faint">
      {item.error && <span className={item.error === "Interrupted" ? "" : "text-danger/80"}>{item.error}</span>}
      <span>{took}</span>
      <button
        onClick={copy}
        title="Copy response"
        className="rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
