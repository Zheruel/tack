// Transcript views for the tools Tack gives every agent: `show` draws a visual inline, `ask`
// leaves a record of what was asked and answered, `agent` is a card for the sub-agent it started.

import { Ban, Check, ChevronRight, X } from "lucide-react";
import type { Item, Question, Thread } from "../../../shared/protocol";
import { openThread, useApp } from "../store";
import { ProviderLogo } from "./Logos";
import { isThreadDescendant } from "./Approvals";

export { Visual } from "./Visual";

type Tool = Extract<Item, { kind: "tool" }>;

// Claude sees them as mcp__tack__<name>, Codex by their plain name.
export function tackTool(name: string): "ask" | "show" | "agent" | "wrap_up" | undefined {
  const bare = name.replace(/^mcp__tack__/, "");
  return bare === "ask" || bare === "show" || bare === "agent" || bare === "wrap_up" ? bare : undefined;
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

type AgentStatus = NonNullable<Thread["agent"]>["status"];
type AgentResult = { id?: string; threadId?: string; name?: string; model?: string; status?: AgentStatus; error?: string; started?: boolean };

function agentResult(output?: string): AgentResult {
  if (!output) return {};
  try {
    const value: unknown = JSON.parse(output);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      return {
        id: typeof result.id === "string" ? result.id : undefined,
        threadId: typeof result.threadId === "string" ? result.threadId : undefined,
        name: typeof result.name === "string" ? result.name : undefined,
        model: typeof result.model === "string" ? result.model : undefined,
        status: ["running", "waiting", "cancelling", "completed", "failed", "cancelled"].includes(String(result.status)) ? result.status as AgentStatus : undefined,
        error: typeof result.error === "string" ? result.error : undefined,
        started: typeof result.started === "boolean" ? result.started : undefined,
      };
    }
  } catch { /* Earlier transcripts used plain-text agent results. */ }
  const legacy = /^(?:Agent|Started) "(.+?)"/.exec(output);
  const id = legacy ? /\(id\s+([\w-]+)/.exec(output)?.[1] : undefined;
  if (legacy) return { id, name: legacy[1] };
  return { error: output.replace(/^(?:Not started|Error):\s*/, ""), started: false };
}

// One row per sub-agent: who, on what, and whether it is running or needs the user.
export function AgentCard({ tool, threadId }: { tool: Tool; threadId: string }) {
  const input = (tool.input ?? {}) as { name?: string; task?: string; model?: string };
  const result = agentResult(tool.output);
  const id = result.threadId ?? result.id;
  const child = useApp((s) => {
    const candidate = id ? s.threads[id] : result.name ? Object.values(s.threads).find((t) => t.parentId === threadId && t.title === result.name) : undefined;
    return candidate?.parentId === threadId ? candidate : undefined;
  });
  const model = child?.model ?? result.model ?? input.model;
  const label = useApp((s) => s.models.find((m) => m.value === model)?.label ?? model);
  const needsUser = useApp((s) => !!child && (
    Object.values(s.approvals).some((a) => isThreadDescendant(s.threads, a.threadId, child.id)) ||
    Object.values(s.threads).some((t) => t.questions?.length && isThreadDescendant(s.threads, t.id, child.id))
  ));

  if (result.error || result.started === false) {
    return <p className="my-2 text-[13px] text-danger">Agent not started: {result.error ?? "The request was declined."}</p>;
  }
  const status = child?.agent?.status ?? result.status ?? (child?.status === "running" ? "running" : child?.status === "error" ? "failed" : child ? "completed" : "starting");
  const state = needsUser && (status === "running" || status === "waiting") ? "waiting" : status;

  return (
    <button
      disabled={!child}
      onClick={() => child && openThread(child.id)}
      title={input.task}
      className="group my-1.5 flex w-full items-center gap-3 rounded-xl border border-line/70 px-3.5 py-2 text-left transition-colors enabled:hover:bg-hover/50"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {state === "running" || state === "starting" || state === "cancelling" ? (
          <span className="spin size-3 rounded-full border-[1.5px] border-line border-t-brass" />
        ) : state === "completed" ? (
          <Check size={14} className="text-ok/80" />
        ) : state === "failed" ? (
          <X size={14} className="text-danger" />
        ) : state === "cancelled" ? (
          <Ban size={14} className="text-faint" />
        ) : (
          <span className="pulse size-2 rounded-full bg-brass" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{child?.title ?? result.name ?? input.name ?? "Agent"}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-faint">
        {state === "waiting" && <span className="text-brass">Needs you</span>}
        {state === "failed" && <span className="text-danger">Failed</span>}
        {state === "cancelling" && <span>Stopping…</span>}
        {state === "cancelled" && <span>Cancelled</span>}
        {child && <ProviderLogo provider={child.provider} className="size-3" />}
        {label}
        <ChevronRight size={13} className="opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
    </button>
  );
}
