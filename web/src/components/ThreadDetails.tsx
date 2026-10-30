// The thread details card at the top right, modeled on T3 Code's: where the work happens
// (project, editor), what it produced (branch, PRs and their CI, uncommitted changes) and the
// sub-agents working on it (lineage). Toggled from the header.

import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Bot,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleX,
  CornerLeftUp,
  FileDiff,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  SquareArrowOutUpRight,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { GitInfo, PullRequest, Thread } from "../../../shared/protocol";
import { openExternal } from "../native";
import { call } from "../rpc";
import { loadPrs, openThread, useApp } from "../store";
import { MenuContent, MenuItem } from "./Composer";
import { ProviderLogo } from "./Logos";

const REFRESH_MS = 30_000;
// Beside the chat only when the transcript column (720px) keeps its width with a card on each side.
const FIT_WIDTH = 720 + 2 * (280 + 24);
const ROW = "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-ink/80";
const HOVER = "transition-colors hover:bg-white/[0.07]";
const ICON = "size-4 shrink-0 text-faint";

export function ThreadDetails({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId])!;
  const fit = useApp((s) => s.detailsFit);
  const open = useApp((s) => (s.detailsFit ? s.details : s.detailsPeek));
  const git = useGit(thread.projectId, thread.status);
  const card = useRef<HTMLElement>(null);
  usePrs(threadId, thread.status);
  useFit();

  // Over the chat it closes like a popover: Esc, or a click outside.
  useEffect(() => {
    if (fit || !open) return;
    const close = () => useApp.setState({ detailsPeek: false });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc closes the card, not the running turn
      close();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!card.current?.contains(target) && !target.closest?.("[data-details-toggle], [data-radix-popper-content-wrapper]")) close(); // menus open from the card are portaled outside it
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [fit, open]);

  if (!open) return null;
  return (
    <aside
      ref={card}
      className="dock-in absolute top-[50px] right-3 z-20 flex max-h-[calc(100%-180px)] w-[280px] flex-col overflow-y-auto rounded-2xl border border-white/10 bg-raised/95 shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] backdrop-blur-xl"
    >
      <Workspace thread={thread} />
      <VersionControl threadId={threadId} git={git} />
      <Lineage thread={thread} />
    </aside>
  );
}

function Section({ title, action, children }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-line/65 px-2 pt-2 pb-2.5 first:border-t-0">
      {title && (
        <div className="mb-1 flex min-h-7 items-center justify-between gap-2 px-2.5 text-[11.5px] font-medium text-faint select-none">
          {title}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// ---- workspace

function Workspace({ thread }: { thread: Thread }) {
  const project = useApp((s) => s.projects.find((p) => p.id === thread.projectId));
  const editors = useEditors();
  const [preferred, setPreferred] = useState(() => localStorage.getItem("tack.editor") ?? "");
  if (!project) return null;
  const editor = editors.includes(preferred) ? preferred : editors[0];
  const openIn = (name: string) => {
    localStorage.setItem("tack.editor", name);
    setPreferred(name);
    call("editor.open", { projectId: project.id, editor: name });
  };
  return (
    <Section>
      <button onClick={() => call("project.reveal", { projectId: project.id })} title={`${project.path}\nShow in Finder`} className={`${ROW} ${HOVER}`}>
        <Folder className={ICON} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </button>
      {editor && (
        <div className={`group/split flex items-center rounded-lg ${HOVER}`}>
          <button onClick={() => openIn(editor)} className={`${ROW} flex-1 rounded-e-none`}>
            <SquareArrowOutUpRight className={ICON} />
            <span className="min-w-0 truncate">Open in {editor}</span>
          </button>
          {editors.length > 1 && (
            <>
              <span className="h-4 w-px shrink-0 bg-transparent group-hover/split:bg-line/65" />
              <Menu.Root>
                <Menu.Trigger className="flex h-8 w-8 shrink-0 items-center justify-center rounded-e-lg text-faint outline-none hover:text-dim">
                  <ChevronDown size={14} />
                </Menu.Trigger>
                <MenuContent side="bottom">
                  {editors.map((name) => (
                    <MenuItem key={name} selected={name === editor} label={name} onSelect={() => openIn(name)} />
                  ))}
                </MenuContent>
              </Menu.Root>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

let editorList: Promise<string[]> | undefined;
function useEditors(): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    editorList ??= call("editors.list", {}).catch(() => []);
    editorList.then(setList);
  }, []);
  return list;
}

// ---- version control

function VersionControl({ threadId, git }: { threadId: string; git?: GitInfo }) {
  const prs = useApp((s) => s.prs[threadId]) ?? NO_PRS;
  if (!git?.branch) return null;
  const { additions, deletions } = git.changes;
  return (
    <Section>
      <div className={ROW} title="Current branch">
        <GitBranch className={ICON} />
        <span className="min-w-0 flex-1 truncate">{git.branch}</span>
      </div>
      {prs.map((pr) => (
        <PrRow key={pr.url} pr={pr} />
      ))}
      <div className={ROW} title={`${git.changes.files} uncommitted ${git.changes.files === 1 ? "file" : "files"}`}>
        <FileDiff className={ICON} />
        <span className="flex-1">Changes</span>
        <span className="font-mono text-[12px] tabular-nums">
          <span className={additions ? "text-ok" : "text-faint"}>+{additions.toLocaleString()}</span>{" "}
          <span className={deletions ? "text-danger/90" : "text-faint"}>−{deletions.toLocaleString()}</span>
        </span>
      </div>
    </Section>
  );
}

const NO_PRS: PullRequest[] = [];

export const PR_STATE = {
  OPEN: { icon: GitPullRequestArrow, color: "text-emerald-300/90", label: "Open" },
  DRAFT: { icon: GitPullRequestDraft, color: "text-zinc-400/80", label: "Draft" },
  MERGED: { icon: GitMerge, color: "text-violet-300/90", label: "Merged" },
  CLOSED: { icon: GitPullRequestClosed, color: "text-red-300/90", label: "Closed" },
};

export const prState = (pr: PullRequest) => PR_STATE[pr.draft && pr.state === "OPEN" ? "DRAFT" : pr.state];

const CHECKS = {
  pass: { icon: CircleCheck, color: "text-ok", label: "Checks passing" },
  fail: { icon: CircleX, color: "text-danger", label: "Checks failing" },
  pending: { icon: CircleDot, color: "text-amber-400/90", label: "Checks running" },
};

function PrRow({ pr }: { pr: PullRequest }) {
  const state = prState(pr);
  const checks = pr.checks && pr.state === "OPEN" ? CHECKS[pr.checks] : undefined;
  return (
    <button onClick={() => openExternal(pr.url)} title={`${state.label}: ${pr.title}\nOpen on GitHub`} className={`w-full rounded-lg px-2.5 py-1.5 text-left ${HOVER}`}>
      <span className="flex gap-2.5">
        <state.icon className={`mt-px size-4 shrink-0 ${state.color}`} />
        <span className="line-clamp-2 min-w-0 text-[13px] leading-[18px] font-medium text-ink/85">{pr.title}</span>
      </span>
      <span className="mt-0.5 flex h-5 items-center gap-2 ps-[26px] text-[12px] text-faint tabular-nums">
        #{pr.number}
        <span className="font-mono text-[11.5px]">
          <span className="text-ok/80">+{pr.additions.toLocaleString()}</span> <span className="text-danger/80">−{pr.deletions.toLocaleString()}</span>
        </span>
        {checks && (
          <span className={`ml-auto flex items-center gap-1 ${checks.color}`} title={checks.label}>
            <checks.icon size={12} />
            {checks.label.replace("Checks ", "")}
          </span>
        )}
        {!checks && pr.state !== "OPEN" && <span className={`ml-auto ${state.color}`}>{state.label}</span>}
      </span>
    </button>
  );
}

// ---- lineage

function Lineage({ thread }: { thread: Thread }) {
  const parent = useApp((s) => (thread.parentId ? s.threads[thread.parentId] : undefined));
  const children = useApp(useShallow((s) => Object.values(s.threads).filter((t) => t.parentId === thread.id)));
  const [showPrevious, setShowPrevious] = useState(false);
  const active = children.filter((t) => t.status === "running").sort((a, b) => a.createdAt - b.createdAt);
  const previous = children.filter((t) => t.status !== "running").sort((a, b) => b.updatedAt - a.updatedAt);
  const failed = previous.filter((t) => t.status === "error").length;
  const now = useNow(active.length > 0);
  if (!parent && !children.length) return null;

  return (
    <Section title={active.length ? `Lineage · ${active.length} running` : "Lineage"}>
      <ul className="max-h-[13.5rem] overflow-y-auto">
        {parent && (
          <li>
            <button onClick={() => openThread(parent.id)} title="Open the thread that started this agent" className={`${ROW} ${HOVER}`}>
              <CornerLeftUp className={ICON} />
              <span className="min-w-0 flex-1 truncate">{parent.title}</span>
              <span className="text-[11.5px] text-faint">Parent</span>
            </button>
          </li>
        )}
        {active.map((t) => (
          <AgentRow key={t.id} thread={t} now={now} />
        ))}
        {previous.length > 0 && (
          <li>
            <button onClick={() => setShowPrevious(!showPrevious)} className={`${ROW} ${HOVER} text-faint`}>
              <Bot className={ICON} />
              <span className="flex-1">Previous agents</span>
              {failed > 0 && <span className="text-[11.5px] text-danger">{failed} failed</span>}
              {!showPrevious && <span className="text-[11.5px] tabular-nums">{previous.length}</span>}
              <ChevronDown size={14} className={`transition-transform ${showPrevious ? "" : "-rotate-90"}`} />
            </button>
          </li>
        )}
        {showPrevious && previous.map((t) => <AgentRow key={t.id} thread={t} now={now} />)}
      </ul>
    </Section>
  );
}

function AgentRow({ thread, now }: { thread: Thread; now: number }) {
  const running = thread.status === "running";
  const waiting = useApp(
    (s) => !!thread.questions?.length || Object.values(s.approvals).some((a) => a.threadId === thread.id),
  );
  const dot = waiting ? "bg-brass" : running ? "bg-sky-400" : thread.status === "error" ? "bg-danger" : "bg-ok";
  const elapsed = (running ? now : thread.updatedAt) - thread.createdAt;
  return (
    <li className="group relative">
      <button onClick={() => openThread(thread.id)} title={`${thread.title} · ${thread.model}`} className={`${ROW} ${HOVER}`}>
        <span className="relative shrink-0">
          <ProviderLogo provider={thread.provider} className="size-4" />
          <span className={`absolute -right-1 -bottom-1 size-2 rounded-full border-2 border-raised ${dot}`} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ink/85">{thread.title}</span>
        <span className={`text-[11.5px] tabular-nums transition-opacity ${running ? "group-hover:opacity-0" : ""} ${thread.status === "error" ? "text-danger" : "text-faint"}`}>
          {waiting ? "Needs you" : thread.status === "error" ? "Failed" : duration(elapsed)}
        </span>
      </button>
      {running && (
        <button
          onClick={() => call("chat.interrupt", { threadId: thread.id })}
          title="Stop agent"
          className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-danger opacity-0 transition-opacity group-hover:opacity-100 hover:bg-danger/10"
        >
          <Square size={11} fill="currentColor" />
        </button>
      )}
    </li>
  );
}

// "19s", "4m", "1.5h", "12h"
function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = s / 3600;
  return h >= 10 ? `${Math.floor(h)}h` : `${h.toFixed(1)}h`;
}

function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

// ---- data

function useFit() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const observer = new ResizeObserver(([e]) => {
      const fit = e!.contentRect.width >= FIT_WIDTH;
      if (fit !== useApp.getState().detailsFit) useApp.setState({ detailsFit: fit, detailsPeek: false });
    });
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
}

// Refetch when the project changes, when a turn ends (work may have been committed or pushed),
// and every so often while the window is in front.
function useRefresh(load: () => void, deps: unknown[], status: string) {
  useEffect(() => {
    if (status === "running") return;
    load();
    const timer = setInterval(() => document.hasFocus() && load(), REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [...deps, status]);
}

function useGit(projectId: string, status: string): GitInfo | undefined {
  const [info, setInfo] = useState<{ projectId: string; git: GitInfo }>();
  useRefresh(() => void call("git.info", { projectId }).then((git) => setInfo({ projectId, git })), [projectId], status);
  return info?.projectId === projectId ? info.git : undefined;
}

function usePrs(threadId: string, status: string) {
  const prsChanged = useApp((s) => s.threads[threadId]?.prs?.length ?? 0);
  useRefresh(() => void loadPrs(threadId), [threadId, prsChanged], status);
}
