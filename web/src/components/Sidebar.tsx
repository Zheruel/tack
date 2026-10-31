import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Ctx from "@radix-ui/react-context-menu";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FolderPlus,
  ListFilter,
  PanelLeft,
  MessageCircleQuestion,
  RotateCcw,
  Search,
  ShieldQuestion,
  SquarePen,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project, Thread } from "../../../shared/protocol";
import { pickFolder } from "../native";
import { call } from "../rpc";
import { isThreadDescendant, loadPrs, openThread, setShowSettled, setSidebar, startDraft, useApp } from "../store";
import { MenuContent, MenuItem } from "./Composer";
import { ProviderLogo } from "./Logos";
import { ProjectIcon } from "./ProjectIcon";
import { prState } from "./ThreadDetails";
import { Updates } from "./Updates";

export async function addProject() {
  const path = await pickFolder();
  if (!path) return;
  const project = await call("project.add", { path });
  startDraft(project.id);
}

const FILTER_KEY = "tack.sidebarProject";

// Re-renders once a minute so the relative times stay true.
function useMinute() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// Sized like T3 Code's: 16rem by default, draggable from 13rem up to what leaves the chat 40rem.
const MIN_WIDTH = 208;
const DEFAULT_WIDTH = 272;
const MAIN_MIN_WIDTH = 640;
const WIDTH_KEY = "tack.sidebarWidth";

const clampWidth = (w: number) => Math.round(Math.min(Math.max(MIN_WIDTH, window.innerWidth - MAIN_MIN_WIDTH), Math.max(MIN_WIDTH, w)));

function useSidebarWidth() {
  const [width, set] = useState(() => clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH));
  useEffect(() => {
    const onResize = () => set((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setWidth = (w: number, persist = true) => {
    const next = clampWidth(w);
    set(next);
    if (persist) localStorage.setItem(WIDTH_KEY, String(next));
  };
  return [width, setWidth] as const;
}

// The strip on the sidebar's right edge: drag to resize, double-click to reset.
function ResizeRail({ width, onResize, dragging, setDragging }: { width: number; onResize: (w: number, persist?: boolean) => void; dragging: boolean; setDragging: (d: boolean) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize sidebar"
      onDoubleClick={() => onResize(DEFAULT_WIDTH)}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let last = startWidth;
        setDragging(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const move = (ev: PointerEvent) => {
          last = clampWidth(startWidth + ev.clientX - startX);
          onResize(last, false);
        };
        const up = () => {
          setDragging(false);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onResize(last);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      className="group/rail absolute inset-y-0 -right-1.5 z-30 w-3 cursor-col-resize"
    >
      <span
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${dragging ? "bg-brass/70" : "bg-transparent group-hover/rail:bg-brass/40"}`}
      />
    </div>
  );
}

interface Result {
  thread: Thread;
  // Where a message mentions the query; absent for title, project and branch matches.
  snippet?: string;
}

// One flat list across every project, newest first, in the shape of T3 Code's sidebar.
export function Sidebar() {
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  const approvals = useApp((s) => s.approvals);
  const unread = useApp((s) => s.unread);
  const drafting = useApp((s) => !!s.draft);
  const activeId = useApp((s) => s.activeThreadId);
  const hasProjects = projects.length > 0;
  const now = useMinute();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(() => localStorage.getItem(FILTER_KEY));
  const [highlight, setHighlight] = useState(0);
  const [width, setWidth] = useSidebarWidth();
  const [dragging, setDragging] = useState(false);
  const open = useApp((s) => s.sidebar);
  const input = useRef<HTMLInputElement>(null);
  const filtered = filter && projects.some((p) => p.id === filter) ? filter : null;

  // Sub-agents live inside their parent's thread; what they need shows on the parent.
  const owner = (id: string) => {
    const seen = new Set<string>();
    let thread = threads[id];
    const projectId = thread?.projectId;
    while (thread?.parentId) {
      if (seen.has(thread.id) || thread.projectId !== projectId) return;
      seen.add(thread.id);
      thread = threads[thread.parentId];
    }
    return thread && isThreadDescendant(threads, id, thread.id) ? thread.id : undefined;
  };
  const waiting = new Set<string>();
  const asking = new Set<string>();
  for (const a of Object.values(approvals)) {
    const id = owner(a.threadId);
    if (id) waiting.add(id);
  }
  const agentsWorking = new Set<string>();
  for (const t of Object.values(threads)) {
    const id = owner(t.id);
    if (!id) continue;
    if (t.questions?.length) { waiting.add(id); asking.add(id); }
    const status = t.agent?.status ?? t.status;
    if (t.parentId && status === "waiting") waiting.add(id);
    if (t.parentId && ["running", "waiting", "cancelling"].includes(status)) agentsWorking.add(id);
  }
  const top = Object.values(threads)
    .filter((t) => !t.parentId && (!filtered || t.projectId === filtered))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const live = top.filter((t) => !t.settled);
  const settled = top.filter((t) => t.settled);

  const q = query.trim().toLowerCase();
  const results = useSearch(q, top, projects);

  useEffect(() => setHighlight(0), [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setSidebar(true);
        input.current?.focus();
        input.current?.select();
      } else if (e.metaKey && e.key === "b") {
        e.preventDefault();
        setSidebar(!useApp.getState().sidebar);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (r: Result | undefined) => {
    if (!r) return;
    setQuery("");
    openThread(r.thread.id);
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else input.current?.blur();
    } else if (q && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((i) => (results.list.length ? (i + by + results.list.length) % results.list.length : 0));
    } else if (q && e.key === "Enter") {
      e.preventDefault();
      choose(results.list[highlight]);
    }
  };
  const pickFilter = (id: string | null) => {
    setFilter(id);
    if (id) localStorage.setItem(FILTER_KEY, id);
    else localStorage.removeItem(FILTER_KEY);
  };

  const rowProps = { now, waiting, asking, agentsWorking, unread, activeId, projects };

  return (
    <aside
      style={{ width: open ? width : 0 }}
      inert={!open}
      className={`relative h-full shrink-0 bg-rail font-system ${dragging ? "" : "transition-[width] duration-200 ease-out"}`}
    >
      {open && <ResizeRail width={width} onResize={setWidth} dragging={dragging} setDragging={setDragging} />}
      <div style={{ width }} className="flex h-full flex-col overflow-hidden">
      {/* Sits beside the macOS traffic lights; the strip drags the window. */}
      <div data-tauri-drag-region className="flex h-[46px] shrink-0 items-center pr-3 pl-[124px]">
        <Brand />
      </div>
      <div className="flex items-center gap-1 p-2">
        <label className="group/search flex h-8 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 text-dim transition-colors focus-within:bg-hover focus-within:text-ink hover:bg-hover/60">
          <Search size={16} strokeWidth={1.75} className="shrink-0" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search"
            aria-label="Search threads"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-ink outline-none placeholder:text-dim"
          />
          {query ? (
            <button
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
              title="Clear search"
              className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-faint hover:text-ink"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd className="font-sans text-xs text-faint opacity-0 transition-opacity group-focus-within/search:opacity-0 group-hover/search:opacity-100">⌘K</kbd>
          )}
        </label>
        {projects.length > 1 && (
          <Menu.Root>
            <Menu.Trigger
              title={filtered ? `Showing ${projects.find((p) => p.id === filtered)?.name}` : "Filter by project"}
              className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-hover/70 data-[state=open]:bg-hover ${
                filtered ? "text-brass" : "text-dim hover:text-ink"
              }`}
            >
              <ListFilter size={16} strokeWidth={1.75} />
            </Menu.Trigger>
            <MenuContent side="bottom">
              <MenuItem selected={!filtered} label="All projects" onSelect={() => pickFilter(null)} />
              {projects.map((p) => (
                <MenuItem key={p.id} selected={p.id === filtered} label={p.name} onSelect={() => pickFilter(p.id)} />
              ))}
            </MenuContent>
          </Menu.Root>
        )}
        <IconButton title="Add project" onClick={addProject}>
          <FolderPlus size={16} strokeWidth={1.75} />
        </IconButton>
        <IconButton title="New thread (⌘N)" active={drafting} onClick={() => (hasProjects ? startDraft(filtered ?? undefined) : addProject())}>
          <SquarePen size={16} strokeWidth={1.75} />
        </IconButton>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2 pt-0">
        {q ? (
          results.list.length ? (
            <ul role="listbox" aria-label="Thread search results" className="flex flex-col gap-px">
              {results.list.map((r, i) => (
                <ResultRow
                  key={r.thread.id}
                  result={r}
                  query={q}
                  now={now}
                  project={projects.find((p) => p.id === r.thread.projectId)}
                  highlighted={i === highlight}
                  active={r.thread.id === activeId}
                  onHover={() => setHighlight(i)}
                  onChoose={() => choose(r)}
                />
              ))}
            </ul>
          ) : (
            <p role="status" className="px-2.5 py-6 text-center text-xs text-faint">
              {results.pending ? "Searching messages…" : "No threads found"}
            </p>
          )
        ) : (
          <>
            <div className="flex flex-col">
              {live.map((t) => (
                <ThreadRow key={t.id} thread={t} {...rowProps} />
              ))}
            </div>
            {top.length === 0 && (
              <p className="px-2.5 py-2 text-xs leading-relaxed text-faint">
                {filtered ? "No threads in this project." : hasProjects ? "Threads you start show up here." : "Add a project folder to start."}
              </p>
            )}
          </>
        )}
      </nav>

      {!q && <Settled threads={settled} rowProps={rowProps} />}
      <Updates />
      </div>
    </aside>
  );
}

// The app icon's tack, drawn small, beside the name.
function Brand() {
  return (
    <span className="pointer-events-none inline-flex items-center gap-1.5 select-none">
      <svg viewBox="0 0 24 24" aria-hidden className="size-[18px]">
        <defs>
          <linearGradient id="tack-brass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e2c27e" />
            <stop offset="1" stopColor="#a9823f" />
          </linearGradient>
        </defs>
        <ellipse cx="12" cy="8" rx="7.5" ry="3" fill="url(#tack-brass)" />
        <ellipse cx="12" cy="7.3" rx="5.9" ry="1.8" fill="#ecd39c" opacity="0.45" />
        <path d="M10.6 10.4 L13.4 10.4 L12.4 20.6 Q12 21.6 11.6 20.6 Z" fill="url(#tack-brass)" />
      </svg>
      <span className="text-sm font-semibold tracking-tight text-ink">Tack</span>
    </span>
  );
}

// Sits beside the traffic lights whether or not the sidebar is open, so it never moves.
export function SidebarToggle() {
  const open = useApp((s) => s.sidebar);
  return (
    <button
      onClick={() => setSidebar(!open)}
      title={`${open ? "Hide" : "Show"} sidebar (⌘B)`}
      aria-label="Toggle sidebar"
      aria-pressed={open}
      className="fixed top-[11px] left-[88px] z-40 flex size-6 cursor-pointer items-center justify-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink"
    >
      <PanelLeft size={16} strokeWidth={1.75} />
    </button>
  );
}

function IconButton({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors ${
        active ? "bg-hover text-ink" : "text-dim hover:bg-hover/70 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// Title, project and branch matches come at once; message matches follow from the server.
function useSearch(q: string, threads: Thread[], projects: Project[]): { list: Result[]; pending: boolean } {
  const [found, setFound] = useState<{ q: string; hits: { threadId: string; snippet: string }[] }>({ q: "", hits: [] });
  useEffect(() => {
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      call("threads.search", { query: q })
        .then((hits) => setFound({ q, hits }))
        .catch(() => setFound({ q, hits: [] }));
    }, 180);
    return () => clearTimeout(timer);
  }, [q]);

  const words = q.split(/\s+/).filter(Boolean);
  const byTitle: Result[] = threads
    .filter((t) => {
      const hay = `${t.title} ${projects.find((p) => p.id === t.projectId)?.name ?? ""} ${t.branch ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((thread) => ({ thread }));
  const seen = new Set(byTitle.map((r) => r.thread.id));
  const allowed = new Map(threads.map((t) => [t.id, t]));
  const byContent: Result[] = [];
  if (found.q === q)
    for (const hit of found.hits) {
      const thread = allowed.get(hit.threadId);
      if (thread && !seen.has(thread.id)) byContent.push({ thread, snippet: hit.snippet });
    }
  return { list: [...byTitle, ...byContent], pending: q.length >= 2 && found.q !== q };
}

// Pinned to the bottom of the rail; opens upward into its own scroll area.
function Settled({ threads, rowProps }: { threads: Thread[]; rowProps: RowShared }) {
  const open = useApp((s) => s.showSettled);
  if (!threads.length) return null;
  return (
    <div className="shrink-0 border-t border-line/60 p-2">
      <button
        onClick={() => setShowSettled(!open)}
        className="mx-0.5 flex h-8 w-[calc(100%-4px)] cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-faint transition-colors hover:text-dim"
      >
        Settled
        <span className="ml-auto font-normal tabular-nums">{open ? "" : threads.length}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="flex max-h-[38vh] min-h-0 flex-col overflow-y-auto">
          {threads.map((t) => (
            <ThreadRow key={t.id} thread={t} {...rowProps} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface RowShared {
  now: number;
  waiting: Set<string>;
  asking: Set<string>;
  agentsWorking: Set<string>;
  unread: Record<string, true>;
  activeId?: string;
  projects: Project[];
}

type Tone = "brass" | "danger" | "ok";
const TONE: Record<Tone, string> = { brass: "text-brass", danger: "text-danger", ok: "text-ok" };

// What the thread needs from you, shown top right where the time otherwise sits.
function statusOf(t: Thread, { waiting, asking, agentsWorking, unread }: RowShared, approval: boolean) {
  if (waiting.has(t.id))
    return approval
      ? { label: "Approval", icon: ShieldQuestion, tone: "brass" as Tone }
      : { label: asking.has(t.id) ? "Question" : "Needs you", icon: MessageCircleQuestion, tone: "brass" as Tone };
  if (t.status === "error") return { label: "Failed", icon: CircleAlert, tone: "danger" as Tone };
  if (t.status === "running" || agentsWorking.has(t.id))
    return { label: t.status === "running" ? "Working" : "Agents", icon: CircleDashed, tone: "brass" as Tone, spin: true };
  if (unread[t.id]) return { label: "Done", icon: CircleCheck, tone: "ok" as Tone };
  return null;
}

function ThreadRow({ thread, ...shared }: { thread: Thread } & RowShared) {
  const active = shared.activeId === thread.id;
  const project = shared.projects.find((p) => p.id === thread.projectId);
  const approval = useApp((s) =>
    Object.values(s.approvals).some((a) => isThreadDescendant(s.threads, a.threadId, thread.id)),
  );
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = statusOf(thread, shared, approval);
  const unread = !!shared.unread[thread.id];
  const waiting = shared.waiting.has(thread.id);
  const dim = thread.settled && !active;

  const settle = () => call("thread.settle", { threadId: thread.id, settled: !thread.settled });
  const rename = (title: string) => {
    setRenaming(false);
    if (title.trim() && title !== thread.title) call("thread.rename", { threadId: thread.id, title });
  };

  return (
    <Ctx.Root onOpenChange={(open) => !open && setConfirmDelete(false)}>
      <Ctx.Trigger asChild>
        <div className="py-0.5">
          <div
            role="button"
            tabIndex={0}
            onClick={() => !renaming && openThread(thread.id)}
            onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && !renaming && openThread(thread.id)}
            className={`group relative h-[78px] cursor-pointer overflow-hidden rounded-md px-2.5 py-2 text-left outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-brass/40 focus-visible:ring-inset data-[state=open]:bg-hover/70 ${
              active ? "bg-hover" : "hover:bg-hover/55"
            }`}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectIcon
                project={project}
                className={`size-4 transition-[opacity,filter] ${dim ? "opacity-50 grayscale group-hover:opacity-100 group-hover:grayscale-0" : active ? "" : "opacity-80 group-hover:opacity-100"}`}
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-dim">{project?.name ?? "No project"}</span>
              <span className="flex h-5 shrink-0 items-center justify-end text-xs tabular-nums">
                <span className={`flex items-center gap-1 group-hover:invisible ${status ? `${TONE[status.tone]} font-medium` : "text-faint"}`}>
                  {status ? (
                    <>
                      <status.icon size={16} className={"spin" in status ? "animate-spin [animation-duration:2.4s]" : ""} />
                      {status.label}
                    </>
                  ) : (
                    ago(thread.updatedAt, shared.now)
                  )}
                </span>
              </span>
            </div>
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
                className="mt-1 block h-5 w-full rounded-sm border border-line bg-canvas px-1 text-sm font-medium text-ink outline-none focus:border-ink/60"
              />
            ) : (
              <div
                className={`mt-1 h-5 truncate text-sm leading-5 font-medium transition-colors ${
                  thread.titling ? "animate-pulse " : ""
                }${
                  dim ? "text-dim group-hover:text-ink" : unread || waiting ? "text-ink" : "text-ink/90"
                }`}
              >
                {thread.title}
              </div>
            )}
            <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs text-faint">
              {thread.branch ? (
                <span className="min-w-0 flex-1 truncate" title={thread.branch}>
                  {thread.branch}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <PrBadge thread={thread} />
              <span title={thread.provider === "codex" ? "Codex" : "Claude"} className="flex shrink-0 items-center">
                <ProviderLogo provider={thread.provider} className="size-3.5" />
              </span>
            </div>
            {!renaming && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  settle();
                }}
                title={thread.settled ? "Move back to active" : "Settle"}
                className="absolute top-2 right-1.5 hidden h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-dim group-hover:flex hover:text-ink"
              >
                {thread.settled ? <RotateCcw size={14} /> : <Check size={14} />}
                {thread.settled ? "Reopen" : "Settle"}
              </button>
            )}
          </div>
        </div>
      </Ctx.Trigger>
      <Ctx.Portal>
        <Ctx.Content className="z-50 min-w-44 rounded-xl border border-line bg-raised p-1 shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)]">
          <CtxItem onSelect={() => setTimeout(() => setRenaming(true), 0)}>Rename</CtxItem>
          <CtxItem disabled={thread.titling} onSelect={() => call("thread.regenerateTitle", { threadId: thread.id })}>
            Regenerate title
          </CtxItem>
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

// A search hit: the title, and for message matches the line around the first mention.
function ResultRow({
  result,
  query,
  now,
  project,
  highlighted,
  active,
  onHover,
  onChoose,
}: {
  result: Result;
  query: string;
  now: number;
  project?: Project;
  highlighted: boolean;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const { thread, snippet } = result;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <li ref={ref} role="option" aria-selected={highlighted} onMouseMove={onHover} onClick={onChoose} className="list-none">
      <div
        className={`flex min-h-9 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 ${
          highlighted || active ? "bg-hover" : ""
        }`}
      >
        <ProjectIcon project={project} className="mt-[3px] size-4" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
              <Mark text={thread.title} query={query} />
            </span>
            <PrBadge thread={thread} />
            <span className="w-8 shrink-0 text-right text-xs text-faint tabular-nums">{ago(thread.updatedAt, now)}</span>
          </div>
          {snippet ? (
            <div className="mt-0.5 line-clamp-2 text-xs leading-snug break-words text-faint">
              <Mark text={snippet} query={query} />
            </div>
          ) : (
            <div className="mt-px truncate text-xs text-faint">
              {[project?.name, thread.branch].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// Brass underline-free highlight of every query word.
function Mark({ text, query }: { text: string; query: string }) {
  const words = query.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-brass/25 text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function CtxItem({
  children,
  danger,
  disabled,
  onSelect,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: (e: Event) => void;
}) {
  return (
    <Ctx.Item
      onSelect={onSelect}
      disabled={disabled}
      className={`flex h-8 cursor-default items-center rounded-lg px-2.5 text-[13px] outline-none data-disabled:opacity-40 ${
        danger ? "text-danger data-highlighted:bg-danger/10" : "text-ink data-highlighted:bg-hover"
      }`}
    >
      {children}
    </Ctx.Item>
  );
}

function ago(ts: number, now: number) {
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

// The newest PR the thread opened, colored by its state, as in T3 Code's sidebar.
function PrBadge({ thread }: { thread: Thread }) {
  const prs = useApp((s) => s.prs[thread.id]);
  const urls = thread.prs?.length ?? 0;
  useEffect(() => {
    if (urls) loadPrs(thread.id);
  }, [thread.id, urls]);
  const own = prs?.filter((p) => thread.prs?.includes(p.url));
  const pr = own?.[own.length - 1];
  if (!pr) return null;
  const state = prState(pr);
  return (
    <span
      title={own!.map((p) => `#${p.number} ${prState(p).label}: ${p.title}`).join("\n")}
      className="flex shrink-0 items-center gap-0.5 tabular-nums"
    >
      <state.icon size={12} className={state.color} />#{pr.number}
      {own!.length > 1 && <span className="opacity-70">+{own!.length - 1}</span>}
    </span>
  );
}
