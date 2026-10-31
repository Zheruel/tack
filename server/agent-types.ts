// Durable app-owned delegation. A child keeps its identity across follow-ups; each task has a generation.
export type AgentStatus = "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled";
export type AgentDelivery = "pending" | "queued" | "delivered" | "acknowledged" | "disposed";

export interface AgentWorkspace {
  kind: "shared" | "worktree";
  path: string;
  branch?: string;
}

export interface AgentTaskRecord {
  id: string; // child thread id
  parentId: string;
  generation: number;
  parentGeneration?: number;
  status: AgentStatus;
  body?: string;
  delivery: AgentDelivery;
  deliveryId?: string;
  deliveryAttempts?: number;
  startedAt: number;
  startMessageId?: string;
  requestKey?: string;
  questionId?: string;
  questionNotified?: boolean;
  workspace?: AgentWorkspace;
}

export const agentTaskKey = (task: Pick<AgentTaskRecord, "id" | "generation">) => `${task.id}:${task.generation}`;
export const agentTerminal = (task: Pick<AgentTaskRecord, "status">) => ["completed", "failed", "cancelled"].includes(task.status);
