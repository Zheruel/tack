import { ArrowUpRight, ChevronDown, CornerDownLeft, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Composer as ActualComposer } from '../../../web/src/components/Composer';
import { suggestions, variant } from './fixture';
import { accept, eligible, useConcept } from './state';
export { MenuContent, MenuItem } from '../../../web/src/components/Composer';

export function Composer(props: { threadId?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { dismissed, accepted, index, sent } = useConcept();
  const show = eligible() && !dismissed && !accepted && !hasDraft && !sent;
  const ghost = variant === 'ghost' && show;
  const shelf = variant === 'shelf' && show;
  const suggestion = suggestions[index]!;
  useEffect(() => {
    const el = root.current?.querySelector('textarea');
    setCard(root.current?.querySelector('.composer-card') ?? null);
    if (!el) return;
    const onInput = () => setHasDraft(!!el.value);
    el.addEventListener('input', onInput);
    const send = () => useConcept.setState({ sent: true });
    window.addEventListener('concept-send', send);
    return () => { el.removeEventListener('input', onInput); window.removeEventListener('concept-send', send); };
  }, []);
  const choose = (text: string) => { accept(text); setExpanded(false); };
  return <div ref={root} className={`ns-composer-wrap ${ghost ? 'has-ghost' : ''}`} onKeyDownCapture={e => {
    if (ghost && e.key === 'Tab' && !e.shiftKey && e.target instanceof HTMLTextAreaElement && !e.currentTarget.querySelector('textarea')?.value) { e.preventDefault(); choose(suggestion.message); }
    if ((ghost || shelf) && e.key === 'Escape') { useConcept.setState({ dismissed: true }); setExpanded(false); }
  }}>
    {shelf && <div className="ns-shelf-wrap">
      <section className="ns-shelf" aria-label="Suggested next prompt">
        <div className="ns-shelf-header"><span className="ns-eyebrow">Suggested next prompt</span><div className="ns-shelf-tools"><button className="ns-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>2 more<ChevronDown size={12} /></button><button className="ns-icon" aria-label="Dismiss suggestions for this turn" title="Dismiss for this turn" onClick={() => useConcept.setState({ dismissed: true })}><X size={14} /></button></div></div>
        <button className="ns-prompt-button" aria-label={`Use prompt: ${suggestion.message}`} onClick={() => choose(suggestion.message)}><span>{suggestion.message}</span><ArrowUpRight size={17} /></button>
        {expanded && <div className="ns-alternatives" aria-label="Other suggested prompts">{suggestions.map((s, i) => i !== index && <button key={s.label} onClick={() => { useConcept.setState({ index: i }); setExpanded(false); }}><span className="ns-row-text"><span className="ns-row-title">{s.label}</span><span className="ns-row-description">{s.description}</span></span><ArrowUpRight size={15} /></button>)}</div>}
      </section>
    </div>}
    <ActualComposer {...props} />
    {ghost && card && createPortal(<div className="ns-ghost-content">
      <div className="ns-ghost-heading"><span className="ns-eyebrow">Suggested next prompt</span><button className="ns-icon" aria-label="Dismiss suggestions for this turn" onClick={e => { e.stopPropagation(); useConcept.setState({ dismissed: true }); }}><X size={14} /></button></div>
      <button className="ns-ghost-text" aria-label={`Use prompt: ${suggestion.message}`} onClick={e => { e.stopPropagation(); choose(suggestion.message); }}>{suggestion.message}</button>
      <div className="ns-ghost-hint"><kbd>Tab</kbd><span>to edit</span><span className="ns-ghost-dot">·</span><span>or type your own</span></div>
    </div>, card)}
    {sent && <div className="ns-demo-toast" role="status"><CornerDownLeft size={13} />Sent in preview · no agent started<button onClick={() => location.reload()}>Reset</button></div>}
  </div>;
}
