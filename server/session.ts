// What the hub needs from an agent backend. Claude and Codex both implement it.

import type { Access, Attachment, Command, Effort, Item, ModelOption, Provider } from "../shared/protocol";

export interface SessionEvents {
  // `final` items are complete and safe to persist; others are still streaming.
  item(item: Item, final: boolean): void;
  delta(itemId: string, text: string): void;
  sessionId(id: string): void;
  usage(used: number, window: number): void;
  turnEnd(): void;
  closed(error?: string): void;
  approve(tool: string, input: unknown, signal: AbortSignal): Promise<boolean>;
}

export interface SessionOptions {
  cwd: string;
  model: string;
  effort: Effort;
  access: Access;
  resume?: string;
  bin?: string;
  env: Record<string, string>;
}

export interface AgentSession {
  readonly provider: Provider;
  readonly closed: boolean;
  send(text: string, attachments: Attachment[]): void;
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
  turnEnd() {},
  closed() {},
  approve: async () => false,
};
