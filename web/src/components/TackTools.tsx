// Transcript views for the tools Tack gives every agent: `show` draws a visual inline, `ask`
// leaves a record of what was asked and answered, `agent` is a card for the sub-agent it started.
// `todo` lives in the task list, not here.

import { Check, ChevronRight, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, Question } from "../../../shared/protocol";
import { openThread, useApp } from "../store";
import { ProviderLogo } from "./Logos";

type Tool = Extract<Item, { kind: "tool" }>;

// Claude sees them as mcp__tack__<name>, Codex by their plain name.
export function tackTool(name: string): "ask" | "todo" | "show" | "agent" | undefined {
  const bare = name.replace(/^mcp__tack__/, "");
  return bare === "ask" || bare === "todo" || bare === "show" || bare === "agent" ? bare : undefined;
}

// ---- show

// The agent's HTML runs in an opaque-origin frame with no network: inline styles and scripts only.
const FRAME_CSS = `
:root{--ink:#ece6dd;--dim:#a69d92;--faint:#70685f;--line:#322d29;--raised:#24211e;--accent:#c9a35b;--ok:#8fb38a;--danger:#e0796b;
--font:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;color-scheme:dark}
html,body{margin:0;padding:0;background:transparent;color:var(--ink);font:13.5px/1.5 var(--font)}
*{box-sizing:border-box}`;

function frameDoc(html: string, id: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<style>${FRAME_CSS}</style></head><body>${html}
<script>(()=>{const post=()=>parent.postMessage({tackFrame:${JSON.stringify(id)},height:Math.ceil(document.documentElement.scrollHeight)},"*");
new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post();})()</script></body></html>`;
}

function Frame({ html, height, id, max }: { html: string; height?: number; id: string; max: number }) {
  const [measured, setMeasured] = useState<number>();
  const doc = useMemo(() => frameDoc(html, id), [html, id]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.tackFrame === id && typeof e.data.height === "number") setMeasured(e.data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);
  const h = Math.min(max, Math.max(60, height ?? measured ?? 160));
  return <iframe title="visual" sandbox="allow-scripts" srcDoc={doc} style={{ height: h }} className="block w-full border-0" />;
}

export function Visual({ tool }: { tool: Tool }) {
  const input = (tool.input ?? {}) as { title?: string; html?: string; height?: number };
  const [full, setFull] = useState(false);
  const frameKey = useRef(crypto.randomUUID()).current;
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  if (!input.html) {
    return (
      <div className="my-3 flex h-24 items-center justify-center gap-2.5 rounded-xl border border-line/70 text-[13px] text-faint">
        <span className="pulse size-1.5 rounded-full bg-brass" />
        Drawing{input.title ? ` ${input.title.toLowerCase()}` : ""}…
      </div>
    );
  }
  return (
    <figure className="group my-3">
      <figcaption className="mb-1.5 flex h-6 items-center gap-2 text-[12.5px] text-faint">
        <span className="truncate">{input.title}</span>
        <button
          onClick={() => setFull(true)}
          title="Expand"
          className="ml-auto flex size-6 items-center justify-center rounded-md opacity-0 transition hover:bg-hover hover:text-ink group-hover:opacity-100"
        >
          <Maximize2 size={12} />
        </button>
      </figcaption>
      <div className="overflow-hidden rounded-xl border border-line/70 p-4">
        <Frame html={input.html} height={input.height} id={frameKey} max={1200} />
      </div>
      {full && (
        <div className="fixed inset-0 z-50 flex flex-col bg-canvas/95 p-8 backdrop-blur-sm" onClick={() => setFull(false)}>
          <div className="mb-3 flex items-center text-[13px] text-dim">
            {input.title}
            <button title="Close (Esc)" className="ml-auto flex size-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink">
              <X size={15} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-line p-6" onClick={(e) => e.stopPropagation()}>
            <Frame html={input.html} id={`${frameKey}-full`} max={100_000} />
          </div>
        </div>
      )}
    </figure>
  );
}

// ---- ask

// What was asked, quietly; the answers follow as the user's message.
export function Asked({ tool }: { tool: Tool }) {
  const questions = ((tool.input ?? {}) as { questions?: Question[] }).questions ?? [];
  if (!questions.length) return null;
  return (
    <div className="my-2 space-y-1 border-l border-line pl-4 text-[13px] leading-snug">
      {questions.map((q, i) => (
        <p key={i} className="text-dim">
          <span className="mr-2 text-faint">{q.header}</span>
          {q.question}
        </p>
      ))}
    </div>
  );
}

// ---- agent

// One row per sub-agent: who, on what, how far along. Opens its thread.
export function AgentCard({ tool, threadId }: { tool: Tool; threadId: string }) {
  const input = (tool.input ?? {}) as { name?: string; task?: string; model?: string };
  const title = tool.output?.match(/^Started "(.+?)"/)?.[1];
  const child = useApp((s) => (title ? Object.values(s.threads).find((t) => t.parentId === threadId && t.title === title) : undefined));
  const label = useApp((s) => s.models.find((m) => m.value === child?.model)?.label ?? child?.model);
  const approval = useApp((s) => !!child && Object.values(s.approvals).some((a) => a.threadId === child.id));

  if (tool.output && !title) {
    return <p className="my-2 text-[13px] text-faint">Agent not started: {tool.output.replace(/^Not started: /, "")}</p>;
  }
  const todos = child?.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const state = !child
    ? "starting"
    : approval || child.questions?.length
      ? "waiting"
      : child.status === "running"
        ? "running"
        : child.status === "error"
          ? "failed"
          : "done";

  return (
    <button
      disabled={!child}
      onClick={() => child && openThread(child.id)}
      title={input.task}
      className="group my-1.5 flex w-full items-center gap-3 rounded-xl border border-line/70 px-3.5 py-2 text-left transition-colors enabled:hover:bg-hover/50"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {state === "running" || state === "starting" ? (
          <span className="spin size-3 rounded-full border-[1.5px] border-line border-t-brass" />
        ) : state === "done" ? (
          <Check size={14} className="text-ok/80" />
        ) : state === "failed" ? (
          <X size={14} className="text-danger" />
        ) : (
          <span className="pulse size-2 rounded-full bg-brass" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{child?.title ?? input.name ?? "Agent"}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-faint">
        {state === "waiting" && <span className="text-brass">Needs you</span>}
        {state === "failed" && <span className="text-danger">Failed</span>}
        {todos.length > 0 && state === "running" && <span className="tabular-nums">{done}/{todos.length}</span>}
        {child && <ProviderLogo provider={child.provider} className="size-3" />}
        {label ?? input.model}
        <ChevronRight size={13} className="opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    </button>
  );
}
