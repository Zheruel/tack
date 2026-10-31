// What the hub needs from an agent backend. Claude and Codex both implement it.

import type { Access, Attachment, Command, Effort, Item, Limit, ModelOption, Provider, Question } from "../shared/protocol";
import type { AgentTool, Role } from "./prompt";

// Accepted by the running turn, or deferred until it finishes (startup, compaction, review).
export type Steered = "sent" | "queue";

export interface ToolResult {
  [key: string]: unknown;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface SessionEvents {
  // `final` items are complete and safe to persist; others are still streaming.
  item(item: Item, final: boolean): void;
  delta(itemId: string, text: string): void;
  sessionId(id: string): void;
  usage(used: number, window: number): void;
  // Plan usage windows; a report may carry only some of them.
  limits(limits: Limit[]): void;
  // The provider accepted the turn, rather than merely starting its process.
  turnStart?(): void;
  turnEnd(): void;
  closed(error?: string): void;
  approve(tool: string, input: unknown, signal: AbortSignal): Promise<boolean>;
  // The agent asked; the answers arrive later as a user message.
  ask(questions: Question[]): void;
  // A sub-agent tool call (start, status, send, cancel); returns what the calling agent is told.
  // `signal` aborts a call that waits.
  agent(tool: AgentTool, input: unknown, signal?: AbortSignal, requestKey?: string): string | Promise<string>;
  surface(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export interface SessionOptions {
  cwd: string;
  model: string;
  effort: Effort;
  access: Access;
  resume?: string;
  // Full transcript context to replay only if the native Codex session cannot be resumed.
  fallbackContext?: string;
  bin?: string;
  env: Record<string, string>;
  // Skills the agent may see; omitted means all of them.
  skills?: string[];
  role?: Role; // default "main"
  // Models this agent may delegate to; omitted means no delegation tools.
  agentModels?: { value: string; provider: Provider }[];
}

export interface AgentSession {
  readonly provider: Provider;
  readonly closed: boolean;
  send(text: string, attachments: Attachment[]): void;
  // Adds input without stopping the running turn. Queue it when there is no active,
  // steerable provider turn; a rejected steer must not become an interruption.
  steer?(text: string, attachments: Attachment[]): Promise<Steered>;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  models(): Promise<ModelOption[]>;
  commands(): Promise<Command[]>;
  close(): void;
}

export const noEvents: SessionEvents = {
  item() {},
  delta() {},
  sessionId() {},
  usage() {},
  limits() {},
  turnEnd() {},
  closed() {},
  approve: async () => false,
  ask() {},
  agent: () => JSON.stringify({ error: "Sub-agents are not available here.", started: false }),
  surface: async () => ({ content: [{ type: "text", text: "Visual and browser tools are not available in a probe session." }], isError: true }),
};
