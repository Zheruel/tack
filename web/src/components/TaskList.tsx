import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../store";

// The agent's plan for the current request, pinned under the latest message. Folds to one
// line once every step is done.
export function TaskList({ threadId }: { threadId: string }) {
  const todos = useApp((s) => s.threads[threadId]?.todos);
  const running = useApp((s) => s.threads[threadId]?.status === "running");
  const done = todos?.filter((t) => t.status === "completed").length ?? 0;
  const finished = !!todos?.length && done === todos.length;
  const [open, setOpen] = useState(!finished);

  useEffect(() => setOpen(!finished), [finished, threadId]);

  if (!todos?.length) return null;

  return (
    <div className={`dock-in mt-2 mb-1 rounded-xl px-3.5 py-2 transition-colors ${finished && !open ? "-mx-3.5 -my-1" : "border border-line/70"}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`group flex h-6 items-center gap-2 text-left text-[12.5px] text-faint hover:text-dim ${finished && !open ? "" : "w-full"}`}
      >
        {finished ? <Check size={13} className="text-ok/80" /> : <span className="tabular-nums">{done}/{todos.length}</span>}
        <span>{finished ? `${todos.length} ${todos.length === 1 ? "task" : "tasks"} done` : running ? "Working through tasks" : "Tasks"}</span>
        <ChevronRight size={12} className={`transition-transform ${finished && !open ? "" : "ml-auto"} ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <ol className="mt-1 mb-0.5 space-y-0.5">
          {todos.map((t, i) => (
            <li key={i} className="flex min-h-6 items-start gap-2.5 text-[13.5px] leading-6">
              <span className="flex h-6 w-3.5 shrink-0 items-center justify-center">
                {t.status === "completed" ? (
                  <Check size={13} className="text-faint" />
                ) : t.status === "in_progress" && running ? (
                  <span className="spin size-3 rounded-full border-[1.5px] border-line border-t-brass" />
                ) : (
                  <span className={`size-2.5 rounded-full border ${t.status === "in_progress" ? "border-brass" : "border-faint/60"}`} />
                )}
              </span>
              <span className={t.status === "completed" ? "text-faint" : t.status === "in_progress" ? "text-ink" : "text-dim"}>{t.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
