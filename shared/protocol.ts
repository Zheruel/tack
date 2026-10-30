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
  // The agent's task list for the current request.
  todos?: Todo[];
  // Questions the agent asked and is waiting on; answering sends them as the next message.
  questions?: Question[];
  // A sub-agent's thread: the thread whose agent started it.
  parentId?: string;
  // GitHub PRs this thread's agents opened (URLs), sub-agents' included.
  prs?: string[];
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

// Provider-neutral transcript items. The UI never branches on provider.
export type Item =
  // `agents`: not typed by the user but sub-agents' reports, delivered by Tack.
  | { id: string; kind: "user"; text: string; attachments?: { name: string; image: boolean }[]; agents?: boolean; ts: number }
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

export interface Queued {
  id: string;
  text: string;
  attachments: Attachment[];
  agents?: boolean; // sub-agents' reports
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  provider: Provider;
  tool: string;
  input: unknown;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
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

export interface GitInfo {
  branch: string | null;
  // Uncommitted work in the tree.
  changes: { files: number; additions: number; deletions: number };
  pr: PullRequest | null;
}

// Client -> server requests. Each carries an id; the server replies with { id, result } or { id, error }.
export interface Requests {
  "state.get": {
    params: {};
    result: { projects: Project[]; threads: Thread[]; models: ModelOption[]; clis: CliStatus[] };
  };
  "project.add": { params: { path: string }; result: Project };
  "project.remove": { params: { projectId: string }; result: null };
  "thread.create": { params: { projectId: string }; result: Thread };
  "thread.rename": { params: { threadId: string; title: string }; result: null };
  "thread.delete": { params: { threadId: string }; result: null };
  "thread.settle": { params: { threadId: string; settled: boolean }; result: null };
  "thread.open": {
    params: { threadId: string };
    result: { items: Item[]; queue: Queued[]; streaming: Item[]; approvals: ApprovalRequest[] };
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
  "chat.interrupt": { params: { threadId: string }; result: null };
  "approval.answer": { params: { approvalId: string; allow: boolean }; result: null };
  "commands.list": { params: { projectId: string; provider: Provider }; result: Command[] };
  "files.search": { params: { projectId: string; query: string }; result: string[] };
  "git.info": { params: { projectId: string }; result: GitInfo };
  // The thread's PRs plus the project branch's, freshest state from GitHub.
  "git.prs": { params: { threadId: string }; result: PullRequest[] };
  "cli.update": { params: { name: CliName }; result: null };
  "project.reveal": { params: { projectId: string }; result: null };
  // Installed apps the project can be opened in, e.g. "Cursor".
  "editors.list": { params: {}; result: string[] };
  "editor.open": { params: { projectId: string; editor: string }; result: null };
}

export type Method = keyof Requests;

export type ClientFrame = { [M in Method]: { id: number; method: M; params: Requests[M]["params"] } }[Method];

// Server -> client pushes.
export type Event =
  | { type: "project.upserted"; project: Project }
  | { type: "project.removed"; projectId: string }
  | { type: "thread.upserted"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  | { type: "models"; models: ModelOption[] }
  // A finished item, or a full replacement of one already sent.
  | { type: "item"; threadId: string; item: Item }
  // Coalesced streaming text for an in-progress item.
  | { type: "delta"; threadId: string; itemId: string; text: string }
  | { type: "queue"; threadId: string; queue: Queued[] }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string }
  | { type: "cli"; status: CliStatus };

export type ServerFrame =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: Event };
