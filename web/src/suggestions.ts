import { wrapUpOf, type ApprovalRequest, type Item, type Queued, type Thread } from "../../shared/protocol";
import { completionOf } from "../../shared/completion";

interface SuggestionState {
  threads: Record<string, Thread>;
  transcripts: Record<string, { order: string[]; byId: Record<string, Item> }>;
  queues: Record<string, Queued[]>;
  approvals: Record<string, ApprovalRequest>;
}

export function promptSuggestion(threadId: string | undefined, state: SuggestionState): { id: string; text: string } | undefined {
  if (!threadId) return;
  const thread = state.threads[threadId];
  const transcript = state.transcripts[threadId];
  if (!thread || thread.parentId || thread.status !== "idle" || !transcript) return;

  const family = (id: string) => {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      if (id === threadId) return true;
      seen.add(id);
      const parent = state.threads[id]?.parentId;
      if (!parent) return false;
      id = parent;
    }
    return false;
  };
  for (const t of Object.values(state.threads)) {
    if (family(t.id) && (t.status === "running" || t.questions?.length || state.queues[t.id]?.length ||
      (t.agent && ["running", "waiting", "cancelling"].includes(t.agent.status)))) return;
  }
  if (Object.values(state.approvals).some(a => family(a.threadId))) return;

  // Never carry a suggestion across a new message, an unfinished turn, or an interruption.
  const end = transcript.byId[transcript.order.at(-1) ?? ""];
  if (end?.kind !== "turn" || end.error) return;
  for (let i = transcript.order.length - 2; i >= 0; i--) {
    const item = transcript.byId[transcript.order[i]!];
    if (!item || item.kind === "user" || item.kind === "turn" || item.kind === "error" || item.kind === "handoff") return;
    if (item.kind === "assistant") {
      const text = item.suggestedPrompt ?? completionOf(item.text).suggestedPrompt;
      if (text === undefined) continue;
      if (Object.values(state.threads).some(t => t.id !== threadId && family(t.id) && t.updatedAt > item.ts)) return;
      return text && text.length <= 240 ? { id: item.id, text } : undefined;
    }
    const wrap = wrapUpOf(item);
    if (!wrap) continue;
    if (item.kind !== "tool" || item.status !== "ok") return;
    // A child finishing after this answer still needs the parent to integrate its report.
    if (Object.values(state.threads).some(t => t.id !== threadId && family(t.id) && t.updatedAt > item.ts)) return;
    const text = wrap.suggestedPrompt ?? wrap.next?.[0]?.message;
    if (text && text.length <= 240) return { id: item.id, text };
    return;
  }
}
