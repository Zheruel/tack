// Disposable local preview: no production server, messages, permissions, or project writes.
import type { Event, Method, Requests } from '../../../shared/protocol';
import { items, projects, threads, models } from './fixture';
const listeners = new Set<(e: Event) => void>();
export const onEvent = (fn: (e: Event) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const onConnect = (_fn: () => void) => () => {};
export function connect() {}
export async function call<M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> {
  let result: unknown = null;
  if (method === 'state.get') result = { projects, threads, models, clis: [], limits: {} };
  if (method === 'thread.open') result = { items, queue: [], held: false, streaming: [], approvals: [] };
  if (method === 'git.prs' || method === 'commands.list' || method === 'files.search' || method === 'threads.search') result = [];
  if (method === 'git.branches') result = { current: 'main', branches: ['main'] };
  if (method === 'git.info') result = { branch: 'main', changes: { files: 3, additions: 0, deletions: 0 }, pr: null };
  if (method === 'desktop.get') result = { available: true, active: false, apps: [] };
  if (method === 'chat.send') {
    window.dispatchEvent(new CustomEvent('concept-send', { detail: params }));
    result = {};
  }
  return result as Requests[M]['result'];
}
