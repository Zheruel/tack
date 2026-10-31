import { Check, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { Item } from '../../../shared/protocol';
import { ItemView as ActualItemView } from '../../../web/src/components/ItemView';
import { ItemView as LegacyItemView } from './LegacyItemView';
import { variant } from './fixture';
import { useConcept } from './state';
export { LiveLine, Steps } from '../../../web/src/components/ItemView';

function AnswerRecord() {
  const answers = useConcept(s => s.answers);
  const [open, setOpen] = useState(false);
  if (!answers?.length) return null;
  return <div className="nx-answer-record">
    <button className="nx-answer-summary" aria-expanded={open} onClick={() => setOpen(!open)}><Check size={13} /><span>{answers.length === 1 ? 'Answered' : `Answered ${answers.length} questions`}</span>{!open && <span className="nx-answer-preview">{answers.map(a => a.answer).join(' · ')}</span>}<ChevronRight size={13} className={open ? 'is-open' : ''} /></button>
    {open && <div className="nx-answer-details">{answers.map(a => <div key={a.question}><p>{a.question}</p><span>{a.answer}</span></div>)}</div>}
  </div>;
}
export function ItemView(props: { threadId: string; item: Item; streaming: boolean }) {
  if (variant === 'list' || variant === 'shelf') return <LegacyItemView {...props} />;
  if (props.item.kind === 'tool' && props.item.name === 'ask') return <AnswerRecord />;
  if (props.item.kind === 'tool' && props.item.name === 'wrap_up') return <ActualItemView {...props} item={{ ...props.item, input: { ...props.item.input as object, next: [] } }} />;
  return <ActualItemView {...props} />;
}
