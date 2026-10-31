import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, FolderPlus, Globe, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Composer, MenuContent, MenuItem } from "./components/Composer";
import { ThreadDetails } from "./components/ThreadDetails";
import { addProject, Sidebar, SidebarToggle } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { BrowserPane } from "./components/BrowserPane";
import { Approval } from "./components/Approvals";
import { Questions } from "./components/Questions";
import { openExternal } from "./native";
import { call } from "./rpc";
import { openThread, startDraft, toggleDetails, updateDraft, useApp } from "./store";

export function App() {
  const ready = useApp((s) => s.ready);
  const activeId = useApp((s) => s.activeThreadId);
  const hasThread = useApp((s) => !!(activeId && s.threads[activeId]));
  const drafting = useApp((s) => !!s.draft);
  const hasProjects = useApp((s) => s.projects.length > 0);
  const browserOpen = useApp((s) => s.browserOpen);
  useShortcuts();

  return (
    <div className="flex h-full">
      <SidebarToggle />
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col border-l border-line/70 bg-canvas">
        {hasThread ? (
            <div className="thread-workspace">
              <div className="thread-chat">
                <Header threadId={activeId!} />
                <ThreadDetails threadId={activeId!} />
                <Transcript threadId={activeId!} />
                <ComposerOrNote threadId={activeId!} />
              </div>
              {browserOpen && <BrowserPane key={activeId!} threadId={activeId!} />}
            </div>
        ) : drafting ? (
          <DraftView />
        ) : (
          <div data-tauri-drag-region className="flex flex-1 flex-col items-center justify-center gap-5">
            {ready && !hasProjects && (
              <>
                <p className="text-[15px] text-dim">Add a project folder to start.</p>
                <button
                  onClick={addProject}
                  className="flex items-center gap-2 rounded-xl bg-brass px-4 py-2 text-[14px] font-medium text-brass-ink hover:brightness-110"
                >
                  <FolderPlus size={16} />
                  Add project
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function DraftView() {
  return (
    <div className="flex flex-1 flex-col">
      <div data-tauri-drag-region className="h-[46px] shrink-0" />
      <div data-tauri-drag-region className="flex flex-1 flex-col justify-center pb-[12vh]">
        <div className="mx-auto mb-5 w-full max-w-[768px] px-10">
          <h1 className="text-[26px] font-medium tracking-[-0.01em] text-ink">
            New thread in <ProjectPicker />
          </h1>
        </div>
        <Composer />
      </div>
    </div>
  );
}

function ProjectPicker() {
  const projects = useApp((s) => s.projects);
  const draft = useApp((s) => s.draft);
  const current = projects.find((p) => p.id === draft?.projectId);

  const remove = async (projectId: string, name: string) => {
    if (!confirm(`Remove ${name} from Tack? Its threads are deleted. The folder itself is untouched.`)) return;
    await call("project.remove", { projectId });
    startDraft(useApp.getState().projects[0]?.id);
  };

  return (
    <Menu.Root>
      <Menu.Trigger className="inline-flex items-center gap-1 rounded-lg px-1 text-brass outline-none hover:bg-hover data-[state=open]:bg-hover">
        {current?.name ?? "a project"}
        <ChevronDown size={18} className="mt-1 text-brass/70" />
      </Menu.Trigger>
      <MenuContent side="bottom">
        {projects.map((p) => (
          <MenuItem
            key={p.id}
            selected={p.id === draft?.projectId}
            label={p.name}
            hint={p.path.replace(/^\/Users\/[^/]+/, "~")}
            onSelect={() => updateDraft({ projectId: p.id })}
          />
        ))}
        <Menu.Separator className="mx-2 my-1.5 h-px bg-line" />
        <MenuItem label="Add project…" onSelect={addProject} />
        {current && <MenuItem label={`Remove ${current.name}`} onSelect={() => remove(current.id, current.name)} />}
      </MenuContent>
    </Menu.Root>
  );
}

// A sub-agent takes its direction from the agent that started it, so its thread has no composer.
function ComposerOrNote({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId]);
  const parent = useApp((s) => (thread?.parentId ? s.threads[thread.parentId] : undefined));
  if (!thread?.parentId) return <Composer threadId={threadId} />;
  const stopping = thread.agent?.status === "cancelling";
  const active = thread.status === "running" || thread.agent?.status === "running" || thread.agent?.status === "waiting" || stopping;
  return (
    <div className="thread-composer mx-auto w-full max-w-[768px] px-8 pb-4">
      <Questions threadId={threadId} />
      <Approval threadId={threadId} />
      <div className="flex w-full items-center gap-3 rounded-2xl border border-line/70 px-4 py-3 text-[13.5px] text-dim">
        <span className="min-w-0 flex-1">
          This agent works for{" "}
          <button onClick={() => parent && openThread(parent.id)} className="text-ink underline decoration-faint underline-offset-2 hover:decoration-ink">
            {parent?.title ?? "its parent thread"}
          </button>
          . Message that thread to steer it.
        </span>
        {active && (
          <button disabled={stopping} onClick={() => call("chat.interrupt", { threadId })} className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-danger enabled:hover:bg-danger/10 disabled:opacity-50">
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
    </div>
  );
}

function Header({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId])!;
  const project = useApp((s) => s.projects.find((p) => p.id === thread.projectId));
  const parent = useApp((s) => (thread.parentId ? s.threads[thread.parentId] : undefined));
  const details = useApp((s) => (s.detailsFit ? s.details : s.detailsPeek));
  const [editing, setEditing] = useState(false);
  const sidebar = useApp((s) => s.sidebar);
  const browserOpen = useApp((s) => s.browserOpen);

  const rename = (title: string) => {
    setEditing(false);
    if (title.trim() && title !== thread.title) call("thread.rename", { threadId, title });
  };

  return (
    <header data-tauri-drag-region data-sidebar={sidebar || undefined} className={`thread-header flex h-[46px] shrink-0 items-center gap-2.5 pr-6 transition-[padding] duration-200 ${sidebar ? "pl-6" : "pl-[128px]"}`}>
      {parent && (
        <button
          onClick={() => openThread(parent.id)}
          title="Back to the thread that started this agent"
          className="flex min-w-0 max-w-[40%] shrink items-center gap-1.5 text-[13.5px] text-faint hover:text-dim"
        >
          <span className="truncate">{parent.title}</span>
          <ChevronRight size={13} className="shrink-0" />
        </button>
      )}
      {editing ? (
        <input
          autoFocus
          defaultValue={thread.title}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-ink outline-none"
        />
      ) : (
        <h1
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
          className="min-w-0 truncate text-[13.5px] font-medium text-ink"
        >
          {thread.title}
        </h1>
      )}
      {project && !editing && (
        <span className="thread-project-chip shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11.5px] text-dim" title={project.path}>
          {project.name}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => useApp.setState({ browserOpen: !browserOpen })}
          title="Browser (⌘⇧B)"
          aria-label="Toggle browser"
          aria-pressed={browserOpen}
          className={`browser-toggle flex size-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink ${browserOpen ? "bg-hover" : ""}`}
        >
          <Globe size={15} strokeWidth={1.8} />
        </button>
        <button
          data-details-toggle
          onClick={toggleDetails}
          title="Thread details"
          aria-label="Toggle thread details"
          aria-pressed={details}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-hover hover:text-ink ${details ? "bg-hover" : ""}`}
        >
          <PanelRight size={15} strokeWidth={1.8} />
        </button>
      </div>
    </header>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useApp.setState((s) => ({ browserOpen: !s.browserOpen }));
        return;
      }
      if (!e.metaKey) return;
      if (e.key === "o") {
        e.preventDefault();
        addProject();
      } else if (e.key === "n") {
        e.preventDefault();
        startDraft();
      }
    };
    // Links in agent output open in the default browser.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a || !/^https?:/.test(a.href)) return;
      e.preventDefault();
      openExternal(a.href);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);
}
