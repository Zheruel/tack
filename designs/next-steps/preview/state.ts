import { create } from 'zustand';
import { useApp, suggestReply } from '../../../web/src/store';
import { lifecycle, suggestions, threadId } from './fixture';
export type Answer = { header: string; question: string; answer: string };
export const useConcept = create<{ dismissed: boolean; accepted: boolean; index: number; sent: boolean; answers?: Answer[]; deferred: boolean }>(() => ({ dismissed: false, accepted: false, index: 0, sent: false, deferred: false }));
export function eligible() {
  const s = useApp.getState();
  const t = s.threads[threadId];
  return lifecycle === 'done' && t?.status === 'idle' && !t.parentId && !t.questions?.length && !s.queues[threadId]?.length && !Object.values(s.threads).some(c => c.parentId === threadId && c.status === 'running');
}
export function accept(text = suggestions[useConcept.getState().index]!.message) {
  suggestReply(threadId, text);
  useConcept.setState({ accepted: true });
}

export function completeAnswers(answers: Answer[]) {
  const s = useApp.getState();
  const threads = Object.fromEntries(Object.entries(s.threads).map(([id, thread]) => [id, { ...thread, questions: undefined }]));
  const transcript = s.transcripts[threadId];
  useConcept.setState({ answers, deferred: false });
  useApp.setState({ threads, ...(transcript?.byId.ask ? { transcripts: { ...s.transcripts, [threadId]: { ...transcript, byId: { ...transcript.byId, ask: { ...transcript.byId.ask, status: 'ok' } as typeof transcript.byId.ask } } } } : {}) });
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
}
