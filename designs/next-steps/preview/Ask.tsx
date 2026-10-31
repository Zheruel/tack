import { ArrowLeft, ArrowUp, Check, ChevronRight, MessageCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../web/src/store';
import { isThreadDescendant } from '../../../web/src/components/Approvals';
import { threadId, scenario } from './fixture';
import { completeAnswers, useConcept, type Answer } from './state';
import { Selection } from './Selection';

export function AskPanel() {
  const target = useApp(s => s.threads[threadId]?.questions?.length ? s.threads[threadId] : Object.values(s.threads).find(t => t.questions?.length && isThreadDescendant(s.threads, t.id, threadId)));
  const questions = target?.questions ?? [];
  const deferred = useConcept(s => s.deferred);
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const failures = useRef(0);
  const lock = useRef(false);
  const card = useRef<HTMLElement>(null);
  const custom = useRef<HTMLInputElement>(null);
  const freeform = useRef<HTMLTextAreaElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const question = questions[index];
  const ready = !!(picks[index]?.length || typed[index]?.trim());
  const last = index === questions.length - 1;
  const answerOf = (i: number, nextPicks = picks) => [...(nextPicks[i] ?? []), typed[i]?.trim()].filter(Boolean).join('; ');
  const pick = (label: string) => {
    if (!question || busy) return;
    setError('');
    setPicks(current => current.map((p, i) => i === index ? question.multiSelect ? p.includes(label) ? p.filter(l => l !== label) : [...p, label] : [label] : p));
    if (!question.multiSelect) setTyped(current => current.map((v, i) => i === index ? '' : v));
  };
  const send = async (answers: Answer[]) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError('');
    await new Promise(resolve => setTimeout(resolve, 320));
    if (scenario === 'error' && failures.current++ === 0) { setError('Couldn’t send your answers. Try again.'); setBusy(false); lock.current = false; return; }
    completeAnswers(answers);
    setBusy(false); lock.current = false;
  };
  const advance = (nextPicks = picks) => {
    if (!answerOf(index, nextPicks) || busy) return;
    setError('');
    if (!last) { setIndex(index + 1); return; }
    void send(questions.map((q, i) => ({ header: q.header, question: q.question, answer: answerOf(i, nextPicks) })));
  };
  useEffect(() => {
    const el = card.current;
    if (!el || deferred) return;
    // The initial fixture starts in this waiting state. Never move focus on selection.
    requestAnimationFrame(() => (question?.options.length ? el : freeform.current ?? el).focus());
  }, [index, deferred]);
  useEffect(() => {
    if (deferred) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
  }, [deferred]);
  useEffect(() => {
    if (error) requestAnimationFrame(() => submit.current?.focus());
  }, [error]);
  useEffect(() => {
    if (!target || !question) return;
    const onSend = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (deferred && text?.trim()) completeAnswers([{ header: question.header, question: question.question, answer: text.trim() }]);
    };
    window.addEventListener('concept-send', onSend);
    return () => window.removeEventListener('concept-send', onSend);
  }, [target, question, deferred]);
  if (!target || !questions.length || !question) return null;
  if (deferred) return <div className="nx-dock"><div className="nx-waiting"><MessageCircle size={14} /><span>{questions.length === 1 ? 'A question is waiting' : `${questions.length} questions are waiting`}</span><button onClick={() => useConcept.setState({ deferred: false })}>Answer<ChevronRight size={13} /></button></div></div>;
  return <div className="nx-dock nx-question-dock"><section ref={card} className="nx-question" aria-labelledby="nx-question-title" tabIndex={-1} onKeyDown={e => {
    if (busy || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); useConcept.setState({ deferred: true }); return; }
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement && e.target.type === 'text';
    const number = Number(e.key);
    if (!typing && number >= 1 && number <= question.options.length) { e.preventDefault(); pick(question.options[number - 1]!.label); }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); advance(); }
  }}>
    <header className="nx-question-heading"><div>{target.parentId && <p className="nx-via">{target.title}</p>}<h2 id="nx-question-title" aria-live="polite">{question.question}</h2></div><button className="nx-icon" disabled={busy} aria-label="Answer later" title="Answer later (Esc)" onClick={() => useConcept.setState({ deferred: true })}><X size={14} /></button></header>
    <div className="nx-question-body">
      <div className="nx-selections" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map((option, i) => <Selection key={option.label} kind={question.multiSelect ? 'checkbox' : 'radio'} name={`question-${index}`} label={option.label} description={option.description} selected={picks[index]?.includes(option.label) ?? false} recommended={!question.multiSelect && i === 0} shortcut={i + 1} disabled={busy} onSelect={() => pick(option.label)} />)}
      </div>
      <label className={`nx-custom ${typed[index]?.trim() ? 'is-selected' : ''} ${!question.options.length ? 'is-freeform' : ''}`}>
        {!!question.options.length && <span className={`nx-mark ${question.multiSelect ? 'checkbox' : 'radio'}`} aria-hidden="true">{typed[index]?.trim() && (question.multiSelect ? <Check size={11} /> : <span />)}</span>}
        {question.options.length ? <input ref={custom} type="text" aria-label="Your answer" disabled={busy} value={typed[index] ?? ''} placeholder={question.multiSelect ? 'Add a detail…' : 'Or write your own answer…'} onChange={e => {
          setError(''); const value = e.target.value;
          setTyped(current => current.map((t, i) => i === index ? value : t));
          if (!question.multiSelect && value) setPicks(current => current.map((p, i) => i === index ? [] : p));
        }} /> : <textarea ref={freeform} rows={3} aria-label="Your answer" disabled={busy} value={typed[index] ?? ''} placeholder="Write your answer…" onChange={e => {
          setError(''); const value = e.target.value; setTyped(current => current.map((t, i) => i === index ? value : t));
        }} />}
      </label>
    </div>
    {error && <p className="nx-question-error" role="alert">{error}</p>}
    <footer className="nx-question-footer"><div className="nx-question-navigation">{index > 0 && <button className="nx-back" disabled={busy} aria-label="Previous question" onClick={() => { setIndex(index - 1); setError(''); }}><ArrowLeft size={14} /></button>}{questions.length > 1 && <span>{index + 1}<span className="nx-progress-total"> / {questions.length}</span></span>}</div><div className="nx-question-actions"><button className="nx-agent-decides" disabled={busy} onClick={() => {
      const updated = picks.map((p, i) => i === index ? ['Agent decides'] : p);
      setPicks(updated); setTyped(current => current.map((t, i) => i === index ? '' : t));
      if (last) void send(questions.map((q, i) => ({ header: q.header, question: q.question, answer: i === index ? 'Agent decides' : answerOf(i) })));
      else { setIndex(index + 1); setError(''); }
    }}>Let agent decide</button><button ref={submit} className="nx-answer-action" disabled={busy || !ready} onClick={() => advance()}>{busy ? 'Sending…' : error ? 'Try again' : last ? questions.length > 1 ? 'Send answers' : 'Send answer' : 'Continue'}{!busy && (last ? <ArrowUp size={14} /> : <ChevronRight size={14} />)}</button></div></footer>
  </section></div>;
}
