import { ArrowRightToLine, Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Composer as ActualComposer } from '../../../web/src/components/Composer';
import { variant, checks, isAsk, visualMode } from './fixture';
import { accept, eligible, useConcept } from './state';
import { Composer as LegacyComposer } from './LegacyComposer';
import { Selection } from './Selection';
import { AskPanel } from './Ask';
import { VisualQuestion } from './VisualQuestion';
export { MenuContent, MenuItem } from '../../../web/src/components/Composer';

function FollowupChoices() {
  const { dismissed, accepted, sent } = useConcept();
  const [selected, setSelected] = useState<number[]>([]);
  if (dismissed || accepted || sent || !eligible()) return null;
  return <section className="nx-followup" aria-label="Next steps">
    <header className="nx-followup-heading"><span>Next steps</span><button className="nx-icon" title="Dismiss for this turn" aria-label="Dismiss next steps" onClick={() => useConcept.setState({ dismissed: true })}><X size={14} /></button></header>
    <div className="nx-selections">{checks.map((choice, i) => <Selection key={choice.label} kind="checkbox" name="followups" label={choice.label} description={choice.description} selected={selected.includes(i)} onSelect={() => setSelected(current => current.includes(i) ? current.filter(n => n !== i) : [...current, i])} />)}</div>
    <footer className="nx-followup-footer"><span aria-live="polite">{selected.length ? `${selected.length} selected` : ''}</span><button className="nx-quiet-action" disabled={!selected.length} onClick={() => accept('Help me grant permissions, then test computer use:\n\n' + [...selected].sort().map(i => '- ' + checks[i]!.request).join('\n'))}>Add to reply<ArrowRightToLine size={13} /></button></footer>
  </section>;
}

export function Composer(props: { threadId?: string }) {
  const { dismissed, accepted, sent } = useConcept();
  const choices = variant === 'choices' && eligible() && !dismissed && !accepted && !sent;
  useEffect(() => {
    const onSend = () => useConcept.setState({ sent: true });
    window.addEventListener('concept-send', onSend);
    return () => window.removeEventListener('concept-send', onSend);
  }, []);
  if (variant === 'shelf' || variant === 'list') return <LegacyComposer {...props} />;
  // The approved prompt design now runs the production component and its real eligibility logic.
  if (variant === 'ghost') return <ActualComposer {...props} />;
  return <div className={`nx-composer ${choices ? 'nx-has-choices' : ''} ${isAsk && !visualMode ? 'nx-ask-composer' : ''}`}>
    {visualMode ? <VisualQuestion mode={visualMode} /> : isAsk ? <AskPanel /> : null}
    {choices && <div className="nx-dock"><FollowupChoices /></div>}
    <ActualComposer {...props} />
    {sent && !isAsk && <div className="nx-preview-sent" role="status"><Check size={13} />Reply sent<button onClick={() => location.reload()}>Reset preview</button></div>}
  </div>;
}
