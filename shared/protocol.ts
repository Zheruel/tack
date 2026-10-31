// Wire protocol between the UI and the sidecar. One WebSocket, JSON frames.

export type Provider = "claude" | "codex";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type Access = "full" | "ask";
export type ThreadStatus = "idle" | "running" | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface BrowserPreview {
  tabs: { tabId: string; url: string; title: string }[];
  currentTabId?: string;
  image?: string;
  needsInstall?: boolean;
  viewport?: { width: number; height: number };
}

export interface BrowserFrame {
  tabId: string;
  image: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

export type BrowserInput =
  | { type: "focus" | "release" }
  | { type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: "none" | "left" | "middle" | "right"; buttons?: number; clickCount?: number; modifiers?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; keyCode: number; modifiers: number; text?: string }
  | { type: "text"; text: string };

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  provider: Provider;
  model: string;
  effort: Effort;
  access: Access;
  status: ThreadStatus;
  // Tokens in the model's context after the last turn, out of its window.
  context?: { used: number; window: number };
  // Questions the agent asked and is waiting on; answering sends them as the next message.
  questions?: Question[];
  // A sub-agent's thread: the thread whose agent started it.
  parentId?: string;
  agent?: { generation: number; status: "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" };
  workspace?: { kind: "shared" | "worktree"; path: string; branch?: string };
  // GitHub PRs this thread's agents opened (URLs), sub-agents' included.
  prs?: string[];
  // The project's git branch as of the thread's last turn.
  branch?: string;
  titling?: boolean; // a title is being written
  // Set by hand, or automatically after a few idle days. Sending a message unsettles it.
  settled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelOption {
  provider: Provider;
  value: string;
  label: string;
  description: string;
  efforts: Effort[];
  // "latest": the current generation, listed first. "more": older or niche models, tucked away.
  group: "latest" | "more";
}

export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT: Effort = "high";

export interface ImageAttachment {
  kind: "image";
  name: string;
  mediaType: string;
  data: string; // base64
}

// A file on disk (e.g. dropped onto the window). Images are inlined by the sidecar; other files are referenced by path.
export interface PathAttachment {
  kind: "path";
  name: string;
  path: string;
}

export type Attachment = ImageAttachment | PathAttachment;

// Paths keep attachments available when another provider takes over the conversation.
export interface TranscriptAttachment {
  name: string;
  image: boolean;
  path?: string;
}

// Provider-neutral transcript items. The UI never branches on provider.
export type Item =
  // `agents`: not typed by the user but sub-agents' reports, delivered by Tack.
  | { id: string; kind: "user"; text: string; attachments?: TranscriptAttachment[]; agents?: boolean; ts: number }
  | { id: string; kind: "assistant"; text: string; ts: number }
  | { id: string; kind: "thinking"; text: string; ts: number }
  | {
      id: string;
      kind: "tool";
      name: string;
      input: unknown;
      output?: string;
      status: "running" | "ok" | "error";
      ts: number;
    }
  | { id: string; kind: "turn"; durationMs: number; costUsd?: number; error?: string; ts: number }
  // The thread moved to another provider; `carried` items of history went with it.
  | { id: string; kind: "handoff"; from: Provider; to: Provider; carried: number; ts: number }
  | { id: string; kind: "error"; text: string; ts: number };

// A `wrap_up` call: the agent's closing message plus what it left unverified and likely follow-ups.
// Claude sees the tool as mcp__tack__wrap_up, Codex as wrap_up.
export interface WrapUp {
  summary: string;
  unverified?: string;
  next?: { label: string; message: string }[];
}

export function wrapUpOf(item: Item): WrapUp | undefined {
  if (item.kind !== "tool" || item.name.replace(/^mcp__tack__/, "") !== "wrap_up") return undefined;
  const i = item.input as Partial<WrapUp> | null;
  if (!i || typeof i.summary !== "string" || !i.summary.trim()) return undefined;
  const seen = new Set<string>();
  const next = Array.isArray(i.next)
    ? i.next.flatMap((n) => {
        if (!n || typeof n.label !== "string" || typeof n.message !== "string") return [];
        const label = n.label.trim();
        const message = n.message.trim();
        if (!label || !message || seen.has(message)) return [];
        seen.add(message);
        return [{ label, message }];
      }).slice(0, 3)
    : [];
  return {
    summary: i.summary,
    unverified: typeof i.unverified === "string" ? i.unverified.trim() || undefined : undefined,
    next: next.length ? next : undefined,
  };
}

export interface Queued {
  id: string;
  text: string;
  attachments: Attachment[];
  agents?: boolean; // sub-agents' reports
  tasks?: string[]; // for reports: the sub-agents they cover
  reportTo?: string; // for a message to a sub-agent: the parent that wants its report when this turn ends
  taskGeneration?: number; // continuation of a child task, including an answer to its question
  answerToQuestions?: string; // question snapshot when submitted; don't dismiss a newer question
  agentQuestion?: { childId: string; generation: number };
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  provider: Provider;
  tool: string;
  input: unknown;
}

// The agent asking the user to choose; free text is always allowed.
export interface Question {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

// Something you can type after "/" in the composer.
export interface Command {
  name: string;
  description: string;
  hint?: string; // argument hint, e.g. "[file]"
  kind: "command" | "skill";
  source?: "app";
}

export type CliName = "claude" | "codex";

export interface CliStatus {
  name: CliName;
  state: "missing" | "current" | "available" | "updating";
  installed?: string;
  latest?: string;
  error?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  additions: number;
  deletions: number;
  checks: "pass" | "fail" | "pending" | null;
}

// One plan usage window, such as the 5-hour or weekly limit.
export interface Limit {
  kind: string;
  label: string;
  percent: number; // 0-100
  resetsAt?: number; // ms
}

export interface GitInfo {
  branch: string | null;
  // Uncommitted work in the tree.
  changes: { files: number; additions: number; deletions: number };
  pr: PullRequest | null;
}

// Client -> server requests. Each carries an id; the server replies with { id, result } or { id, error }.
export interface Requests {
  "browser.get": { params: { threadId: string }; result: BrowserPreview };
  "browser.watch": { params: { threadId: string; visible: boolean }; result: BrowserPreview };
  "browser.resize": { params: { threadId: string; width: number; height: number }; result: null };
  "browser.input": { params: { threadId: string; tabId: string; input: BrowserInput }; result: { clipboard?: string } };
  "browser.install": { params: { threadId: string }; result: null };
  "browser.command": {
    params: { threadId: string; name: "preview_open" | "preview_navigate" | "preview_snapshot" | "preview_close" | "preview_act"; input: { tabId?: string; url?: string; reuseExistingTab?: boolean; action?: "reload" | "back" | "forward" } };
    result: BrowserPreview;
  };
  "visual.get": { params: { threadId: string; id: string }; result: string };
  "state.get": {
    params: {};
    result: { projects: Project[]; threads: Thread[]; models: ModelOption[]; clis: CliStatus[]; limits: Partial<Record<Provider, Limit[]>>; approvals: ApprovalRequest[] };
  };
  "project.add": { params: { path: string }; result: Project };
  "project.remove": { params: { projectId: string }; result: null };
  "thread.create": { params: { projectId: string }; result: Thread };
  "thread.rename": { params: { threadId: string; title: string }; result: null };
  "thread.delete": { params: { threadId: string }; result: null };
  "thread.settle": { params: { threadId: string; settled: boolean }; result: null };
  "thread.open": {
    params: { threadId: string };
    result: { items: Item[]; queue: Queued[]; held: boolean; streaming: Item[]; approvals: ApprovalRequest[] };
  };
  "thread.configure": {
    params: { threadId: string; model?: string; effort?: Effort; access?: Access };
    result: Thread;
  };
  "chat.send": {
    params: { threadId: string; text: string; attachments: Attachment[]; steer?: boolean };
    result: null;
  };
  "chat.unqueue": { params: { threadId: string; queuedId: string }; result: null };
  "chat.steer": { params: { threadId: string; queuedId: string }; result: null };
  "chat.edit": { params: { threadId: string; queuedId: string; text: string }; result: null };
  "chat.resume": { params: { threadId: string }; result: null };
  "chat.interrupt": { params: { threadId: string }; result: null };
  "agent.answer": { params: { threadId: string; text: string }; result: null };
  "approval.answer": { params: { approvalId: string; allow: boolean }; result: null };
  "commands.list": { params: { projectId: string; provider: Provider }; result: Command[] };
  "files.search": { params: { projectId: string; query: string }; result: string[] };
  // The project's favicon as a data URL, found by scanning its files. null: none.
  "project.icon": { params: { projectId: string }; result: string | null };
  // Threads whose messages mention the query, with a snippet around the first hit.
  "thread.regenerateTitle": { params: { threadId: string }; result: null };
  "threads.search": { params: { query: string }; result: { threadId: string; snippet: string; role: "user" | "assistant" }[] };
  "git.info": { params: { projectId: string; threadId?: string }; result: GitInfo };
  "git.branches": { params: { projectId: string }; result: { current: string | null; branches: string[] } };
  // Switches the project's checkout. Fails with git's message if local changes are in the way.
  "git.checkout": { params: { projectId: string; branch: string }; result: null };
  // The thread's PRs plus the project branch's, freshest state from GitHub.
  "git.prs": { params: { threadId: string }; result: PullRequest[] };
  "cli.update": { params: { name: CliName }; result: null };
  "project.reveal": { params: { projectId: string; threadId?: string }; result: null };
  // Installed apps the project can be opened in, e.g. "Cursor".
}

export type Method = keyof Requests;

export type ClientFrame = { [M in Method]: { id: number; method: M; params: Requests[M]["params"] } }[Method];

// Server -> client pushes.
export type Event =
  | { type: "browser.frame"; threadId: string; frame: BrowserFrame }
  | { type: "browser"; threadId: string; preview: BrowserPreview }
  | { type: "project.upserted"; project: Project }
  | { type: "project.removed"; projectId: string }
  | { type: "thread.upserted"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  | { type: "models"; models: ModelOption[] }
  // The latest plan limits the provider reported, merged by kind.
  | { type: "limits"; provider: Provider; limits: Limit[] }
  // A finished item, or a full replacement of one already sent.
  | { type: "item"; threadId: string; item: Item }
  // Coalesced streaming text for an in-progress item.
  | { type: "delta"; threadId: string; itemId: string; text: string }
  | { type: "queue"; threadId: string; queue: Queued[]; held: boolean }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string }
  | { type: "cli"; status: CliStatus };

export type ServerFrame =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: Event };
