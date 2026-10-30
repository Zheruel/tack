import { createCodePlugin } from "@streamdown/code";
import { Check, ChevronRight, Copy, Image as ImageIcon, Paperclip } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Streamdown } from "streamdown";
import type { Item } from "../../../shared/protocol";
import { useApp } from "../store";

const plugins = { code: createCodePlugin({ themes: ["github-light", "vitesse-dark"] }) };
const controls = { code: { copy: true, download: false }, table: false };

type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;
type Tool = Of<"tool">;

export function ItemView({ threadId, item, streaming }: { threadId: string; item: Item; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <Markdown text={item.text} streaming={streaming} />;
    case "turn":
      return <TurnEnd threadId={threadId} item={item} />;
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

function UserMessage({ item }: { item: Of<"user"> }) {
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
        <p className="selectable text-[15px] leading-[1.6] whitespace-pre-wrap text-ink">{item.text}</p>
      </div>
    </div>
  );
}

// ---- steps: a run of tool calls and thinking, collapsed to one line

export function Steps({ threadId, ids, live }: { threadId: string; ids: string[]; live: boolean }) {
  const items = useApp(useShallow((s) => ids.map((id) => s.transcripts[threadId]?.byId[id]).filter(Boolean) as Item[]));
  const [open, setOpen] = useState(false);
  const tools = items.filter((i): i is Tool => i.kind === "tool");
  const failed = tools.some((t) => t.status === "error");
  const current = live ? items[items.length - 1] : undefined;

  // A lone tool call needs no summary line.
  if (items.length === 1 && tools.length === 1) {
    return (
      <div className="py-1">
        <ToolLine tool={tools[0]!} live={live} />
      </div>
    );
  }

  const heading = current
    ? current.kind === "tool"
      ? present(current)
      : { verb: "Thinking", target: undefined }
    : { verb: summarize(items), target: undefined };

  return (
    <div className="py-1">
      <button
        onClick={() => setOpen(!open)}
        className="group flex h-7 max-w-full items-center gap-2 text-left text-[13.5px] text-dim hover:text-ink"
      >
        <Dot state={current ? "running" : failed ? "error" : "done"} />
        <span className="shrink-0">{heading.verb}</span>
        {heading.target && (
          <span className="truncate font-mono text-[12px] text-faint group-hover:text-dim">{heading.target}</span>
        )}
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 mb-1 ml-[3px] border-l border-line pl-4">
          {items.map((item) =>
            item.kind === "tool" ? (
              <ToolLine key={item.id} tool={item} live={false} />
            ) : item.kind === "thinking" ? (
              <ThinkingLine key={item.id} text={item.text} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
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

function present(tool: Tool): { verb: string; target?: string } {
  const input = (tool.input ?? {}) as Record<string, any>;
  const running = tool.status === "running";
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
    case "Task":
    case "Agent":
      return { verb: v("Delegating", "Delegated"), target: input.description };
    default:
      return { verb: tool.name.replace(/^mcp__/, "").replaceAll("__", " ") };
  }
}

// "Read 3 files, edited 2 files, ran 4 commands"
function summarize(items: Item[]): string {
  const count = { read: 0, search: 0, write: 0, edit: 0, run: 0, web: 0, other: 0, think: 0 };
  for (const i of items) {
    if (i.kind === "thinking") count.think++;
    if (i.kind !== "tool") continue;
    if (i.name === "Read") count.read++;
    else if (i.name === "Grep" || i.name === "Glob") count.search++;
    else if (i.name === "Write") count.write++;
    else if (i.name === "Edit" || i.name === "MultiEdit") count.edit++;
    else if (i.name === "Bash") count.run++;
    else if (i.name === "WebFetch" || i.name === "WebSearch") count.web++;
    else count.other++;
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    count.read && `read ${n(count.read, "file", "files")}`,
    count.search && `searched ${n(count.search, "time", "times")}`,
    count.write && `wrote ${n(count.write, "file", "files")}`,
    count.edit && `edited ${n(count.edit, "file", "files")}`,
    count.run && `ran ${n(count.run, "command", "commands")}`,
    count.web && `browsed ${n(count.web, "page", "pages")}`,
    count.other && `used ${n(count.other, "tool", "tools")}`,
  ].filter(Boolean) as string[];
  if (!parts.length) return "Thought";
  const text = parts.join(", ");
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
