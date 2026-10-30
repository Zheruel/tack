// App state. Transcripts are stored as an id order plus a by-id map, so a streaming
// delta replaces one item object and only that row re-renders.

import { create } from "zustand";
import type {
  Access,
  ApprovalRequest,
  Attachment,
  Effort,
  Event,
  Item,
  ModelOption,
  Project,
  Queued,
  Thread,
} from "../../shared/protocol";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../../shared/protocol";
import { call, onConnect, onEvent } from "./rpc";

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
  ready: boolean;
  projects: Project[];
  threads: Record<string, Thread>;
  models: ModelOption[];
  activeThreadId?: string;
  draft?: Draft;
  transcripts: Record<string, Transcript>;
  queues: Record<string, Queued[]>;
  approvals: Record<string, ApprovalRequest>;
  // Threads whose turn finished while you were looking elsewhere.
  unread: Record<string, true>;
  showSettled: boolean;
}

export const useApp = create<State>(() => ({
  ready: false,
  projects: [],
  threads: {},
  models: [],
  transcripts: {},
  queues: {},
  approvals: {},
  unread: load("tack.unread", {}),
  showSettled: false,
}));

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
  const { items, queue, streaming, approvals } = await call("thread.open", { threadId });
  const t: Transcript = { order: [], byId: {} };
  for (const item of [...items, ...streaming]) {
    if (!(item.id in t.byId)) t.order.push(item.id);
    t.byId[item.id] = item;
  }
  set((s) => ({
    transcripts: { ...s.transcripts, [threadId]: t },
    queues: { ...s.queues, [threadId]: queue },
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
        return { threads, activeThreadId: s.activeThreadId === e.threadId ? undefined : s.activeThreadId };
      });
      if (!get().activeThreadId && !get().draft) startDraft();
      return;
    case "models":
      return set({ models: e.models });
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
      return set((s) => ({ queues: { ...s.queues, [e.threadId]: e.queue } }));
    case "approval":
      return set((s) => ({ approvals: { ...s.approvals, [e.request.id]: e.request } }));
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
    const { projects, threads, models } = await call("state.get", {});
    set({ ready: true, projects, threads: Object.fromEntries(threads.map((t) => [t.id, t])), models });
    // Launch on a new thread. On a reconnect, stay where you were.
    const active = get().activeThreadId;
    if (active && get().threads[active]) await openThread(active);
    else if (!get().draft) startDraft();
  });
}
