import { Check, ChevronRight, RotateCcw, SquarePen, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../../../shared/protocol";
import { pickFolder } from "../native";
import { call } from "../rpc";
import { openThread, setShowSettled, startDraft, useApp } from "../store";

export async function addProject() {
  const path = await pickFolder();
  if (!path) return;
  const project = await call("project.add", { path });
  startDraft(project.id);
}

type Section = "attention" | "working" | "active" | "settled";

// One list across every project, grouped by what each thread needs from you.
export function Sidebar() {
  const threads = useApp((s) => s.threads);
  const approvals = useApp((s) => s.approvals);
  const unread = useApp((s) => s.unread);
  const showSettled = useApp((s) => s.showSettled);
  const drafting = useApp((s) => !!s.draft);
  const hasProjects = useApp((s) => s.projects.length > 0);

  const waiting = new Set(Object.values(approvals).map((a) => a.threadId));
  const sections: Record<Section, Thread[]> = { attention: [], working: [], active: [], settled: [] };
  for (const t of Object.values(threads).sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (waiting.has(t.id) || t.status === "error" || (unread[t.id] && t.status !== "running")) sections.attention.push(t);
    else if (t.status === "running") sections.working.push(t);
    else if (t.settled) sections.settled.push(t);
    else sections.active.push(t);
  }

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col bg-rail">
      {/* Room for the macOS traffic lights; the strip drags the window. */}
      <div data-tauri-drag-region className="h-[46px] shrink-0" />
      <div className="px-2.5 pb-3">
        <button
          onClick={() => (hasProjects ? startDraft() : addProject())}
          className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors ${
            drafting ? "bg-hover text-ink" : "text-dim hover:bg-hover/70 hover:text-ink"
          }`}
        >
          <SquarePen size={14} strokeWidth={1.8} />
          New thread
          <kbd className="ml-auto font-sans text-[11px] text-faint">⌘N</kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <Group title="Needs you" threads={sections.attention} />
        <Group title="Working" threads={sections.working} />
        <Group title="Active" threads={sections.active} />
        {sections.settled.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowSettled(!showSettled)}
              className="flex h-6 w-full items-center gap-1 px-2.5 text-[11.5px] font-medium text-faint hover:text-dim"
            >
              Settled
              <span className="font-normal">{sections.settled.length}</span>
              <ChevronRight size={12} className={`ml-auto transition-transform ${showSettled ? "rotate-90" : ""}`} />
            </button>
            {showSettled && sections.settled.map((t) => <ThreadRow key={t.id} thread={t} />)}
          </div>
        )}
        {Object.keys(threads).length === 0 && (
          <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-faint">
            {hasProjects ? "Threads you start show up here." : "Add a project folder to start."}
          </p>
        )}
      </nav>
    </aside>
  );
}

function Group({ title, threads }: { title: string; threads: Thread[] }) {
  if (!threads.length) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h2 className="flex h-6 items-center px-2.5 text-[11.5px] font-medium text-faint">{title}</h2>
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} />
      ))}
    </div>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const active = useApp((s) => s.activeThreadId === thread.id);
  const project = useApp((s) => s.projects.find((p) => p.id === thread.projectId));
  const waiting = useApp((s) => Object.values(s.approvals).some((a) => a.threadId === thread.id));
  const unread = useApp((s) => !!s.unread[thread.id]);
  const [confirming, setConfirming] = useState(false);

  const status = waiting
    ? { dot: "bg-brass", label: "Needs approval" }
    : thread.status === "error"
      ? { dot: "bg-danger", label: "Failed" }
      : thread.status === "running"
        ? { dot: "bg-brass pulse", label: "Working" }
        : unread
          ? { dot: "bg-ink", label: "Finished" }
          : null;

  const settle = (e: React.MouseEvent) => {
    e.stopPropagation();
    call("thread.settle", { threadId: thread.id, settled: !thread.settled });
  };
  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirming) return setConfirming(true);
    call("thread.delete", { threadId: thread.id });
  };

  return (
    <div
      onClick={() => openThread(thread.id)}
      onMouseLeave={() => setConfirming(false)}
      className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] transition-colors ${
        active ? "bg-hover" : "hover:bg-hover/50"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[13px] leading-snug group-hover:pr-14 ${
            active || unread || waiting ? "text-ink" : "text-dim group-hover:text-ink"
          } ${unread ? "font-medium" : ""}`}
        >
          {thread.title}
        </div>
        <div className="mt-px flex items-center gap-1.5 text-[11.5px] leading-snug text-faint">
          {status && <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />}
          <span className="truncate">{status ? status.label : project?.name}</span>
          {status && project && <span className="truncate opacity-70">{project.name}</span>}
          <span className="ml-auto shrink-0 group-hover:invisible">{ago(thread.updatedAt)}</span>
        </div>
      </div>
      <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-hover pl-1 group-hover:flex">
        <button
          onClick={settle}
          title={thread.settled ? "Move back to active" : "Settle"}
          className="rounded-md p-1 text-faint hover:text-ink"
        >
          {thread.settled ? <RotateCcw size={13} /> : <Check size={13} />}
        </button>
        <button
          onClick={remove}
          title={confirming ? "Click again to delete" : "Delete"}
          className={`rounded-md p-1 ${confirming ? "text-danger" : "text-faint hover:text-ink"}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function ago(ts: number) {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}
