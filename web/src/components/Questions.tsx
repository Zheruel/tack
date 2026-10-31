import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Question } from "../../../shared/protocol";
import { call } from "../rpc";
import { useApp } from "../store";
import { isThreadDescendant } from "./Approvals";

// The agent asking before it builds. Docked on top of the composer, one question at a time:
// 1-4 picks an option, ↵ moves on, Esc skips. The answers go back as your next message, so
// typing a reply in the composer instead works too.
export function Questions({ threadId }: { threadId: string }) {
  const target = useApp((s) => {
    const own = s.threads[threadId];
    return own?.questions?.length ? own : Object.values(s.threads).find((t) => t.questions?.length && isThreadDescendant(s.threads, t.id, threadId));
  });
  const questions = target?.questions;
  if (!target || !questions?.length) return null;
  return <Card key={`${target.id}:${JSON.stringify(questions)}`} threadId={target.id} via={target.id === threadId ? undefined : target.title} questions={questions} />;
}

const send = (threadId: string, text: string) => useApp.getState().threads[threadId]?.parentId
  ? call("agent.answer", { threadId, text })
  : call("chat.send", { threadId, text, attachments: [] });

function Card({ threadId, questions, via }: { threadId: string; questions: Question[]; via?: string }) {
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ""));
  const other = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const q = questions[index]!;
  const last = index === questions.length - 1;

  const answerOf = (i: number) => [...picks[i]!, typed[i]!.trim()].filter(Boolean).join(", ");
  const reply = async (text: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError("");
    try { await send(threadId, text); }
    catch (e) {
      submitting.current = false;
      setSending(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const submit = (finalPicks = picks, finalTyped = typed) => {
    const lines = questions.map((x, i) => `${x.header}: ${[...finalPicks[i]!, finalTyped[i]!.trim()].filter(Boolean).join(", ") || "your call"}`);
    void reply(lines.join("\n"));
  };
  const skip = () => void reply("Your call: go with your recommendations.");
  const next = (finalPicks = picks, finalTyped = typed) => (last ? submit(finalPicks, finalTyped) : setIndex(index + 1));

  const pick = (label: string) => {
    if (sending) return;
    const updated = picks.map((p, i) =>
      i !== index ? p : q.multiSelect ? (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]) : [label],
    );
    setPicks(updated);
    if (!q.multiSelect) {
      const cleared = typed.map((v, i) => (i === index ? "" : v));
      setTyped(cleared);
      next(updated, cleared);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sending || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const composer = card.current?.closest(".thread-composer");
      const inComposer = !!composer && target instanceof HTMLTextAreaElement && target.closest(".composer-card")?.closest(".thread-composer") === composer && !target.value.trim() && target.getClientRects().length > 0;
      if (!card.current?.contains(target) && !inComposer) return;
      const inOther = e.target === other.current;
      if (!inOther && (target instanceof HTMLInputElement || target.isContentEditable)) return;
      if (e.key === "Enter" && target.closest("button")) return;
      const n = Number(e.key);
      if (!inOther && n >= 1 && n <= q.options.length) pick(q.options[n - 1]!.label);
      else if (e.key === "Enter" && answerOf(index)) next();
      else if (e.key === "Escape") skip();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true); // before the composer's own keys
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div ref={card} data-question-card className="dock-in mb-2 rounded-2xl border border-brass/25 bg-raised px-4 pt-3 pb-3">
      {via && <p className="mb-1 truncate text-[12px] text-brass">{via} needs an answer</p>}
      <div className="mb-1 flex h-5 items-center gap-1.5 text-[12px] text-faint">
        {questions.length > 1
          ? questions.map((x, i) => (
              <button
                key={i}
                disabled={sending}
                onClick={() => setIndex(i)}
                className={`flex items-center gap-1 rounded-md px-1.5 py-px transition-colors ${
                  i === index ? "bg-hover text-ink" : "hover:text-dim"
                }`}
              >
                {answerOf(i) && i !== index && <Check size={11} className="text-ok/80" />}
                {x.header}
              </button>
            ))
          : <span>{q.header}</span>}
        <button
          onClick={skip}
          disabled={sending}
          title="Let the agent decide (Esc)"
          className="ml-auto rounded-md px-1.5 py-px hover:bg-hover hover:text-dim"
        >
          {sending ? "Sending…" : "Skip"}
        </button>
      </div>
      <p className="mb-2 text-[14.5px] leading-snug text-ink">{q.question}</p>
      <div className="space-y-0.5">
        {q.options.map((o, i) => {
          const on = picks[index]!.includes(o.label);
          return (
            <button
              key={o.label}
              disabled={sending}
              onClick={() => pick(o.label)}
              className={`group flex w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                on ? "bg-brass/12" : "hover:bg-hover"
              }`}
            >
              <span
                className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] tabular-nums ${
                  on ? "bg-brass text-brass-ink" : "bg-hover text-faint group-hover:text-dim"
                }`}
              >
                {on && q.multiSelect ? <Check size={11} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13.5px] leading-5 ${on ? "text-ink" : "text-ink/90"}`}>{o.label}</span>
                {o.description && <span className="block text-[12.5px] leading-snug text-faint">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-2">
        <input
          ref={other}
          disabled={sending}
          value={typed[index]}
          onChange={(e) => {
            const v = e.target.value;
            setTyped((t) => t.map((x, i) => (i === index ? v : x)));
            if (!q.multiSelect && v) setPicks((p) => p.map((x, i) => (i === index ? [] : x)));
          }}
          placeholder="Or type your own answer"
          className="h-8 min-w-0 flex-1 rounded-lg bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
        />
        {(q.multiSelect || typed[index]) && (
          <button
            disabled={sending || !answerOf(index)}
            onClick={() => next()}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-brass px-2.5 text-[12.5px] font-medium text-brass-ink transition enabled:hover:brightness-110 enabled:active:scale-[0.97] disabled:opacity-40"
          >
            {last ? "Send" : "Next"}
            <span className="text-[11px] text-brass-ink/55">↵</span>
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
