// App state. Transcripts are stored as an id order plus a by-id map, so a streaming
// delta replaces one item object and only that row re-renders.

import { create } from "zustand";
import type {
  PullRequest,
  BrowserPreview,
  Access,
  ApprovalRequest,
  Attachment,
  CliName,
  CliStatus,
  Effort,
  Event,
  Item,
  Limit,
  ModelOption,
  Project,
  Provider,
  Queued,
  Thread,
} from "../../shared/protocol";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../../shared/protocol";
import { call, onConnect, onEvent } from "./rpc";
import type { UpdateItem } from "./updates";

export interface Transcript {
  order: string[];
  byId: Record<string, Item>;
}

// A thread that exists only in the UI until its first message is sent.
export interface Draft {
  projectId: string;
  model: string;
  effort: Effort;
  access: Access;
}

interface State {
  browserOpen: boolean;
  browsers: Record<string, BrowserPreview>;
  ready: boolean;
  projects: Project[];
  threads: Record<string, Thread>;
  models: ModelOption[];
  activeThreadId?: string;
  draft?: Draft;
  // A suggested reply waiting to be placed in its thread's composer, never sent automatically.
  composerRequest?: { threadId: string; text: string; attachments?: Attachment[] };
  transcripts: Record<string, Transcript>;
  queues: Record<string, Queued[]>;
  held: Record<string, boolean>; // threads whose queue Stop paused
  approvals: Record<string, ApprovalRequest>;
  // Threads whose turn finished while you were looking elsewhere.
  unread: Record<string, true>;
  showSettled: boolean;
  clis: Partial<Record<CliName, CliStatus>>;
  limits: Partial<Record<Provider, Limit[]>>;
  // CLIs that just finished updating, with the version they came from (shown briefly).
  updatedClis: Partial<Record<CliName, string>>;
  appUpdate?: UpdateItem;
  restartPending: boolean;
  // The thread details card at the top right: kept open beside the chat when there's room
  // (`details`), else shown on demand over it (`detailsPeek`). `detailsFit` says which applies.
  sidebar: boolean; // the thread list is showing
  details: boolean;
  detailsPeek: boolean;
  detailsFit: boolean;
  // Each top thread's PRs with their latest GitHub state.
  prs: Record<string, PullRequest[]>;
  // Project favicons as data URLs; null once a project is known to have none.
  icons: Record<string, string | null>;
}

export const useApp = create<State>(() => ({
  browserOpen: false,
  browsers: {},
  ready: false,
  projects: [],
  threads: {},
  models: [],
  transcripts: {},
  queues: {},
  held: {},
  approvals: {},
  unread: load("tack.unread", {}),
  showSettled: false,
  clis: {},
  limits: {},
  updatedClis: {},
  restartPending: false,
  sidebar: load("tack.sidebar", true),
  details: load("tack.details", true),
  detailsPeek: false,
  detailsFit: true,
  prs: {},
  icons: {},
}));

export function setSidebar(open: boolean) {
  save("tack.sidebar", open);
  useApp.setState({ sidebar: open });
}

export function suggestReply(threadId: string, text: string) {
  if (text.trim()) useApp.setState({ composerRequest: { threadId, text: text.trim() } });
}

export function attachBrowserImage(threadId: string, image: Attachment, url: string) {
  useApp.setState({ composerRequest: { threadId, text: `About this page: ${url}`, attachments: [image] } });
}

export function toggleDetails() {
  const { details, detailsFit, detailsPeek } = useApp.getState();
  if (!detailsFit) return useApp.setState({ detailsPeek: !detailsPeek });
  save("tack.details", !details);
  useApp.setState({ details: !details });
}

// GitHub state for a thread's PRs; a sub-agent's thread shares its parent's.
export async function loadPrs(threadId: string) {
  const prs = await call("git.prs", { threadId }).catch(() => undefined);
  if (prs) useApp.setState((s) => ({ prs: { ...s.prs, [threadId]: prs } }));
}

const iconLoads = new Set<string>();
export async function loadIcon(projectId: string) {
  if (projectId in useApp.getState().icons || iconLoads.has(projectId)) return;
  iconLoads.add(projectId);
  const icon = await call("project.icon", { projectId }).catch(() => null);
  iconLoads.delete(projectId);
  useApp.setState((s) => ({ icons: { ...s.icons, [projectId]: icon } }));
}

const set = useApp.setState;
const get = useApp.getState;

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ---- actions

export async function openThread(threadId: string) {
  set((s) => {
    const { [threadId]: _, ...unread } = s.unread;
    save("tack.unread", unread);
    return { activeThreadId: threadId, draft: undefined, unread };
  });
  const { items, queue, held, streaming, approvals } = await call("thread.open", { threadId });
  const t: Transcript = { order: [], byId: {} };
  for (const item of [...items, ...streaming]) {
    if (!(item.id in t.byId)) t.order.push(item.id);
    t.byId[item.id] = item;
  }
  set((s) => ({
    transcripts: { ...s.transcripts, [threadId]: t },
    queues: { ...s.queues, [threadId]: queue },
    held: { ...s.held, [threadId]: held },
    approvals: { ...s.approvals, ...Object.fromEntries(approvals.map((a) => [a.id, a])) },
  }));
}

// The project a new thread should start in: the one you're looking at, else the most recent.
export function currentProjectId(): string | undefined {
  const s = get();
  if (s.draft) return s.draft.projectId;
  const active = s.activeThreadId && s.threads[s.activeThreadId];
  if (active) return active.projectId;
  return recentThread()?.projectId ?? s.projects[0]?.id;
}

function recentThread(): Thread | undefined {
  return Object.values(get().threads).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function startDraft(projectId = currentProjectId()) {
  if (!projectId) return;
  const s = get();
  set({
    activeThreadId: undefined,
    draft: {
      projectId,
      model: s.draft?.model ?? DEFAULT_MODEL,
      effort: s.draft?.effort ?? DEFAULT_EFFORT,
      access: s.draft?.access ?? "full",
    },
  });
}

export function updateDraft(patch: Partial<Draft>) {
  set((s) => (s.draft ? { draft: { ...s.draft, ...patch } } : {}));
}

export async function sendDraft(text: string, attachments: Attachment[]) {
  const draft = get().draft;
  if (!draft) return;
  const thread = await call("thread.create", { projectId: draft.projectId });
  const configured = await call("thread.configure", {
    threadId: thread.id,
    model: draft.model,
    effort: draft.effort,
    access: draft.access,
  });
  set((s) => ({ threads: { ...s.threads, [thread.id]: configured } }));
  await openThread(thread.id);
  await call("chat.send", { threadId: thread.id, text, attachments });
}

export function setShowSettled(show: boolean) {
  set({ showSettled: show });
}


// ---- server sync

function apply(e: Event) {
  switch (e.type) {
    case "browser":
      return set((s) => ({ browsers: { ...s.browsers, [e.threadId]: e.preview } }));
    case "project.upserted":
      return set((s) => ({ projects: [...s.projects.filter((p) => p.id !== e.project.id), e.project] }));
    case "project.removed":
      return set((s) => ({
        projects: s.projects.filter((p) => p.id !== e.projectId),
        draft: s.draft?.projectId === e.projectId ? undefined : s.draft,
      }));
    case "thread.upserted":
      return set((s) => {
        const prev = s.threads[e.thread.id];
        const finished = prev?.status === "running" && e.thread.status !== "running";
        const unread =
          finished && s.activeThreadId !== e.thread.id ? { ...s.unread, [e.thread.id]: true as const } : s.unread;
        if (unread !== s.unread) save("tack.unread", unread);
        return { threads: { ...s.threads, [e.thread.id]: e.thread }, unread };
      });
    case "thread.removed":
      set((s) => {
        const { [e.threadId]: _, ...threads } = s.threads;
        const { [e.threadId]: _browser, ...browsers } = s.browsers;
        return { threads, browsers, activeThreadId: s.activeThreadId === e.threadId ? undefined : s.activeThreadId };
      });
      if (!get().activeThreadId && !get().draft) startDraft();
      return;
    case "models":
      return set({ models: e.models });
    case "limits":
      return set((st) => ({ limits: { ...st.limits, [e.provider]: e.limits } }));
    case "item":
      return set((s) => {
        const t = s.transcripts[e.threadId];
        if (!t) return {};
        const isNew = !(e.item.id in t.byId);
        return {
          transcripts: {
            ...s.transcripts,
            [e.threadId]: {
              order: isNew ? [...t.order, e.item.id] : t.order,
              byId: { ...t.byId, [e.item.id]: e.item },
            },
          },
        };
      });
    case "delta":
      return set((s) => {
        const t = s.transcripts[e.threadId];
        const item = t?.byId[e.itemId];
        if (!t || !item || !("text" in item)) return {};
        return {
          transcripts: {
            ...s.transcripts,
            [e.threadId]: { order: t.order, byId: { ...t.byId, [e.itemId]: { ...item, text: item.text + e.text } } },
          },
        };
      });
    case "queue":
      return set((s) => ({ queues: { ...s.queues, [e.threadId]: e.queue }, held: { ...s.held, [e.threadId]: e.held } }));
    case "approval":
      return set((s) => ({ approvals: { ...s.approvals, [e.request.id]: e.request } }));
    case "cli": {
      const name = e.status.name;
      const prev = get().clis[name];
      if (prev?.state === "updating" && e.status.state === "current") {
        set((s) => ({ updatedClis: { ...s.updatedClis, [name]: prev.installed } }));
        setTimeout(() => set(({ updatedClis: { [name]: _, ...rest } }) => ({ updatedClis: rest })), 4000);
      }
      return set((s) => ({ clis: { ...s.clis, [name]: e.status } }));
    }
    case "approval.resolved":
      return set((s) => {
        const { [e.approvalId]: _, ...approvals } = s.approvals;
        return { approvals };
      });
  }
}

export function startSync() {
  onEvent(apply);
  onConnect(async () => {
    const { projects, threads, models, clis, limits } = await call("state.get", {});
    set({
      ready: true,
      projects,
      threads: Object.fromEntries(threads.map((t) => [t.id, t])),
      models,
      clis: Object.fromEntries(clis.map((c) => [c.name, c])),
      limits,
    });
    // Launch on a new thread. On a reconnect, stay where you were.
    const active = get().activeThreadId;
    if (active && get().threads[active]) await openThread(active);
    else if (!get().draft) startDraft();
  });
}
