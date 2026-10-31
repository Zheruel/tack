import { ArrowUpRight, Check, X } from 'lucide-react';
import { useState } from 'react';
import type { Item } from '../../../shared/protocol';
import { ItemView as ActualItemView } from '../../../web/src/components/ItemView';
import { suggestions, variant } from './fixture';
import { accept, eligible, useConcept } from './state';
export { LiveLine, Steps } from '../../../web/src/components/ItemView';

function Dismiss() {
  return <button className="ns-icon" aria-label="Dismiss suggestions for this turn" title="Dismiss for this turn" onClick={() => useConcept.setState({ dismissed: true })}><X size={14} /></button>;
}
function NextSteps() {
  const dismissed = useConcept(s => s.dismissed);
  const accepted = useConcept(s => s.accepted);
  const [selected, setSelected] = useState<number[]>([0]);
  const checks = [
    { label: 'Claude and Codex', description: 'Click, type, and read the screen with both providers.', request: 'Verify clicking, typing, and screen reading with Claude and Codex.' },
    { label: 'Stop and revoke access', description: 'Control should stop immediately for both providers.', request: 'Verify that Stop and revoke access immediately stops both providers.' },
    { label: 'Restart and reconnect', description: 'Check that permissions are handled after a restart.', request: 'Restart Tack and check that permissions are handled correctly.' },
  ];
  if (dismissed || accepted || !eligible()) return null;
  if (variant === 'list') return <section className="ns-panel ns-list" aria-label="Suggested next steps">
    <div className="ns-panel-heading"><span className="ns-eyebrow">Suggested next steps</span><Dismiss /></div>
    <h2>Put computer use through its paces</h2>
    <p className="ns-description">Start with a real test, or take a closer look.</p>
    <div className="ns-rows">{suggestions.map((s, i) => <button key={s.label} className="ns-row" onClick={() => accept(s.message)}>
      <span className="ns-number">{String(i + 1).padStart(2, '0')}</span>
      <span className="ns-row-text"><span className="ns-row-title">{s.label}</span><span className="ns-row-description">{s.description}</span></span>
      <ArrowUpRight size={16} className="ns-row-arrow" />
    </button>)}</div>
    <p className="ns-footnote">Choose a step to edit it in your reply.</p>
  </section>;
  if (variant === 'choices') return <section className="ns-panel ns-choices" aria-label="Suggested next steps">
    <div className="ns-panel-heading"><span className="ns-eyebrow">Suggested next steps</span><Dismiss /></div>
    <h2>What would you like to check?</h2>
    <p className="ns-description">Pick one or combine a few in your next request.</p>
    <div className="ns-option-list">{checks.map((s, i) => <label key={s.label} className={`ns-option ${selected.includes(i) ? 'is-selected' : ''}`}>
      <input type="checkbox" checked={selected.includes(i)} onChange={() => setSelected(current => current.includes(i) ? current.filter(n => n !== i) : [...current, i])} />
      <span className="ns-check" aria-hidden="true">{selected.includes(i) && <Check size={12} strokeWidth={2.5} />}</span>
      <span className="ns-row-text"><span className="ns-row-title">{s.label}</span><span className="ns-row-description">{s.description}</span></span>
    </label>)}</div>
    <div className="ns-choice-footer"><span className="ns-footnote">{selected.length} selected · edit before sending</span><button className="ns-primary" disabled={!selected.length} onClick={() => accept('Help me grant the permissions, then test computer use in Tack:\n\n' + [...selected].sort().map(i => '- ' + checks[i]!.request).join('\n'))}>Draft follow-up<ArrowUpRight size={14} /></button></div>
  </section>;
  return null;
}
export function ItemView(props: { threadId: string; item: Item; streaming: boolean }) {
  if (props.item.kind !== 'tool' || props.item.name !== 'wrap_up') return <ActualItemView {...props} />;
  const item = { ...props.item, input: { ...props.item.input as object, next: [] } };
  return <><ActualItemView {...props} item={item} /><NextSteps /></>;
}
