import * as Ctx from "@radix-ui/react-context-menu";
import { Check, ChevronRight, RotateCcw, SquarePen } from "lucide-react";
import { useState } from "react";
import type { Thread } from "../../../shared/protocol";
import { pickFolder } from "../native";
import { call } from "../rpc";
import { openThread, setShowSettled, startDraft, useApp } from "../store";
import { Updates } from "./Updates";

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
        {Object.keys(threads).length === 0 && (
          <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-faint">
            {hasProjects ? "Threads you start show up here." : "Add a project folder to start."}
          </p>
        )}
      </nav>

      <Settled threads={sections.settled} />
      <Updates />
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

// Pinned to the bottom of the rail; opens upward into its own scroll area.
function Settled({ threads }: { threads: Thread[] }) {
  const open = useApp((s) => s.showSettled);
  if (!threads.length) return null;
  return (
    <div className="shrink-0 border-t border-line/60 px-2.5 pt-1.5 pb-1.5">
      <button
        onClick={() => setShowSettled(!open)}
        className="flex h-7 w-full items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-faint transition-colors hover:text-dim"
      >
        <ChevronRight size={12} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        Settled
        <span className="ml-auto tabular-nums">{threads.length}</span>
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="max-h-[38vh] min-h-0 overflow-y-auto">
          {threads.map((t) => (
            <ThreadRow key={t.id} thread={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const active = useApp((s) => s.activeThreadId === thread.id);
  const project = useApp((s) => s.projects.find((p) => p.id === thread.projectId));
  const waiting = useApp((s) => Object.values(s.approvals).some((a) => a.threadId === thread.id));
  const unread = useApp((s) => !!s.unread[thread.id]);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const status = waiting
    ? { dot: "bg-brass", label: "Needs approval" }
    : thread.status === "error"
      ? { dot: "bg-danger", label: "Failed" }
      : thread.status === "running"
        ? { dot: "bg-brass pulse", label: "Working" }
        : unread
          ? { dot: "bg-ink", label: "Finished" }
          : null;

  const settle = () => call("thread.settle", { threadId: thread.id, settled: !thread.settled });
  const rename = (title: string) => {
    setRenaming(false);
    if (title.trim() && title !== thread.title) call("thread.rename", { threadId: thread.id, title });
  };

  return (
    <Ctx.Root onOpenChange={(open) => !open && setConfirmDelete(false)}>
      <Ctx.Trigger asChild>
        <div
          onClick={() => !renaming && openThread(thread.id)}
          className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] transition-colors data-[state=open]:bg-hover/70 ${
            active ? "bg-hover" : "hover:bg-hover/50"
          }`}
        >
          <div className="min-w-0 flex-1">
            {renaming ? (
              <input
                autoFocus
                defaultValue={thread.title}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => rename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="-mx-1 w-[calc(100%+8px)] rounded bg-canvas px-1 text-[13px] leading-snug text-ink outline-none ring-1 ring-brass/50"
              />
            ) : (
              <div
                className={`truncate text-[13px] leading-snug group-hover:pr-6 ${
                  active || unread || waiting ? "text-ink" : "text-dim group-hover:text-ink"
                } ${unread ? "font-medium" : ""}`}
              >
                {thread.title}
              </div>
            )}
            <div className="mt-px flex items-center gap-1.5 text-[11.5px] leading-snug text-faint">
              {status && <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />}
              <span className="truncate">{status ? status.label : project?.name}</span>
              {status && project && <span className="truncate opacity-70">{project.name}</span>}
              <span className="ml-auto shrink-0 group-hover:invisible">{ago(thread.updatedAt)}</span>
            </div>
          </div>
          {!renaming && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                settle();
              }}
              title={thread.settled ? "Move back to active" : "Settle"}
              className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 rounded-md p-1 text-faint group-hover:block hover:bg-line/60 hover:text-ink"
            >
              {thread.settled ? <RotateCcw size={13} /> : <Check size={13} />}
            </button>
          )}
        </div>
      </Ctx.Trigger>
      <Ctx.Portal>
        <Ctx.Content className="z-50 min-w-44 rounded-xl border border-line bg-raised p-1 shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)]">
          <CtxItem onSelect={() => setTimeout(() => setRenaming(true), 0)}>Rename</CtxItem>
          <CtxItem onSelect={settle}>{thread.settled ? "Move back to active" : "Settle"}</CtxItem>
          <Ctx.Separator className="mx-2 my-1 h-px bg-line" />
          <CtxItem
            danger
            onSelect={(e) => {
              if (!confirmDelete) {
                e.preventDefault(); // keep the menu open for the second click
                setConfirmDelete(true);
              } else call("thread.delete", { threadId: thread.id });
            }}
          >
            {confirmDelete ? "Click again to delete" : "Delete"}
          </CtxItem>
        </Ctx.Content>
      </Ctx.Portal>
    </Ctx.Root>
  );
}

function CtxItem({
  children,
  danger,
  onSelect,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onSelect: (e: Event) => void;
}) {
  return (
    <Ctx.Item
      onSelect={onSelect}
      className={`flex h-8 cursor-default items-center rounded-lg px-2.5 text-[13px] outline-none ${
        danger ? "text-danger data-highlighted:bg-danger/10" : "text-ink data-highlighted:bg-hover"
      }`}
    >
      {children}
    </Ctx.Item>
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
