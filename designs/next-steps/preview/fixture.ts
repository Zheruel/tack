import type { Item, ModelOption, Project, Question, Thread } from '../../../shared/protocol';
export const threadId = 'next-steps-concept';
export const variant = new URLSearchParams(location.search).get('variant') ?? 'ghost';
export const lifecycle = new URLSearchParams(location.search).get('lifecycle') ?? 'done';
export const scenario = new URLSearchParams(location.search).get('scenario') ?? 'sequence';
export const visualMode = ['focus', 'stage', 'inspector'].includes(variant) ? variant as 'focus' | 'stage' | 'inspector' : undefined;
export const isAsk = variant === 'ask' || !!visualMode;
const now = Date.now();
export const suggestions = [
  { label: 'Test computer use', description: 'Grant permissions, then try Claude and Codex.', message: 'Help me grant permissions, then test clicking and typing with Claude and Codex.' },
  { label: 'Check Stop and revoke', description: 'Make sure control stops as soon as access is revoked.', message: 'Test Stop and revoke access. Verify that both Claude and Codex stop controlling the app immediately.' },
  { label: 'Review the changes', description: 'Look over the implementation before trying it.', message: 'Review the computer use implementation for bugs and missing cases before I test it.' },
];
export const checks = [
  { label: 'Claude and Codex', description: 'Click, type, and read the screen with both providers.', request: 'Verify clicking, typing, and screen reading with Claude and Codex.' },
  { label: 'Stop and revoke', description: 'Include an in-flight action and a queued one.', request: 'Verify that Stop and revoke stops both in-flight and queued actions.' },
  { label: 'Restart Tack', description: 'Keep granted permissions; clear revoked app access.', request: 'Restart Tack. Verify that granted permissions persist and revoked app access stays revoked.' },
];
const appQuestion: Question = { header: 'Test app', question: 'Which app should I use for the test?', options: [
  { label: 'A separate test app', description: 'Use a disposable window for clicking and typing.' },
  { label: 'An app I already have open', description: 'I’ll ask you to choose a window before starting.' },
] };
const checksQuestion: Question = { header: 'Checks', question: 'Which checks should I run?', multiSelect: true, options: checks.map(({ label, description }) => ({ label, description })) };
export const questions: Question[] = visualMode ? [{ header: 'Browser', question: 'Where should the browser open?', options: [{ label: 'Beside the chat', description: 'One window. The conversation and page stay visible.' }, { label: 'In a separate window', description: 'Give the page more room on another display.' }] }] : scenario === 'single' ? [appQuestion] : scenario === 'multiple' ? [checksQuestion] : scenario === 'freeform' ? [{ header: 'Test app', question: 'Which app and window should I use?', options: [] }] : [appQuestion, checksQuestion];
export const projects: Project[] = [{ id: 'tack', name: 'tack', path: '~/Documents/tack', createdAt: now - 86400000 }];
const base = { projectId: 'tack', provider: 'codex' as const, model: 'gpt-6.1', effort: 'high' as const, access: 'full' as const, status: 'idle' as const, settled: false, createdAt: now - 3600000, updatedAt: now - 120000 };
export const threads: Thread[] = [
  { ...base, id: threadId, title: visualMode ? 'Choose a browser layout' : 'Add computer use to Tack', questions: isAsk && scenario !== 'child' ? questions : undefined, status: lifecycle === 'running' ? 'running' : 'idle', context: { used: 28400, window: 200000 } },
  { ...base, id: 'browser', title: 'Add a browser beside the chat', updatedAt: now - 3600000 },
  { ...base, id: 'composer', title: 'Polish the composer', updatedAt: now - 7200000 },
  { ...base, id: 'providers', title: 'Support Claude and Codex', updatedAt: now - 86400000 },
];
if (lifecycle === 'agents') threads.push({ ...base, id: 'child', title: 'Check permissions', parentId: threadId, status: 'running', agent: { status: 'running' } as Thread['agent'] });
if (isAsk && scenario === 'child') threads.push({ ...base, id: 'question-child', title: 'Check computer use', parentId: threadId, questions, agent: { status: 'waiting' } as Thread['agent'] });
export const models: ModelOption[] = [
  { provider: 'codex', value: 'gpt-6.1', label: 'GPT-6.1', description: 'Coding and everyday work', efforts: ['low', 'medium', 'high', 'xhigh'], group: 'latest' },
  { provider: 'claude', value: 'opus', label: 'Opus', description: 'Most capable', efforts: ['low', 'medium', 'high', 'max'], group: 'latest' },
];
export const items: Item[] = isAsk ? [
  { id: 'request', kind: 'user', text: visualMode ? 'Add a browser to Tack. Let me compare the layouts before we build it.' : 'Test computer use with Claude and Codex. Check with me before choosing an app to control.', ts: now - 180000 },
  { id: 'context', kind: 'assistant', text: visualMode ? 'The browser can share the chat window or open on its own. Here’s how each would fit your workspace.' : 'I can use a separate test window. You’ll approve the app before control starts.', ts: now - 150000 },
  { id: 'ask', kind: 'tool', name: 'ask', input: { questions }, status: 'running', ts: now - 120000 },
] : [
  { id: 'request', kind: 'user', text: 'Add computer use to Tack for Claude and Codex. I want per-app approval, a clear way to stop it, and control over permissions.', ts: now - 180000 },
  { id: 'read', kind: 'tool', name: 'Read', input: { file_path: 'server/desktop.ts' }, status: 'ok', output: 'Read implementation', ts: now - 160000 },
  { id: 'edit', kind: 'tool', name: 'Edit', input: { file_path: 'web/src/components/DesktopControl.tsx' }, status: 'ok', output: 'Updated computer use controls', ts: now - 150000 },
  { id: 'check', kind: 'tool', name: 'Bash', input: { command: 'bun run typecheck' }, status: 'ok', output: 'Passed', ts: now - 140000 },
  { id: 'closing', kind: 'tool', name: 'wrap_up', input: {
    summary: 'Implemented computer use for Claude and Codex, with per-app approval, Stop and revoke controls, and protection against stale screenshots.\n\nOpen the rebuilt **Tack.app**, grant Accessibility and Screen Recording, then restart Tack.',
    unverified: 'Real clicking and typing still need an end-to-end check.',
    next: suggestions.map(({ label, message }) => ({ label, message })),
    suggestedPrompt: variant === 'ghost' ? suggestions[0]!.message : '',
  }, status: 'ok', ts: now - 120000 },
  { id: 'end', kind: 'turn', durationMs: 183000, ts: now - 110000 },
];

if (variant === 'ghost') {
  const at = items.findIndex(item => item.id === 'closing');
  items[at] = { id: 'closing', kind: 'assistant', text: 'Implemented computer use for Claude and Codex, with per-app approval, Stop and revoke controls, and protection against stale screenshots.\n\nOpen the rebuilt **Tack.app**, grant Accessibility and Screen Recording, then restart Tack.\n\nReal clicking and typing still need an end-to-end check.', suggestedPrompt: suggestions[0]!.message, ts: now - 120000 };
}
