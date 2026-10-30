import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowUp, Check, ChevronDown, ChevronRight, Image as ImageIcon, Paperclip, ShieldCheck, ShieldOff, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_EFFORT, type Access, type Attachment, type Effort, type Provider } from "../../../shared/protocol";
import { onFileDrop } from "../native";
import { call } from "../rpc";
import { sendDraft, updateDraft, useApp } from "../store";
import { Approval } from "./Approvals";
import { CompletionMenu, useCompletion, type Suggestion } from "./Autocomplete";
import { ModelPicker } from "./ModelPicker";
import { Questions } from "./Questions";

// Unsent text survives switching threads. Drafts (new threads) share one slot.
const drafts = new Map<string, string>();
const DRAFT = "__draft__";

interface Config {
  model: string;
  effort: Effort;
  access: Access;
}

// Works for an existing thread, or for the draft when no threadId is given.
export function Composer({ threadId }: { threadId?: string }) {
  const thread = useApp((s) => (threadId ? s.threads[threadId] : undefined));
  const draft = useApp((s) => s.draft);
  const config: Config | undefined = thread ?? draft;
  const key = threadId ?? DRAFT;
  const [text, setText] = useState(() => drafts.get(key) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = thread?.status === "running";
  const [caret, setCaret] = useState(0);
  const provider: Provider = useApp((s) => s.models.find((m) => m.value === config?.model)?.provider ?? thread?.provider ?? "claude");
  const projectId = thread?.projectId ?? draft?.projectId;
  const { completion, move, dismiss, setIndex } = useCompletion(text, caret, projectId, provider);

  useEffect(() => {
    setText(drafts.get(key) ?? "");
    setAttachments([]);
    input.current?.focus();
  }, [key]);

  useEffect(() => {
    drafts.set(key, text);
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [text, key]);

  useEffect(() => {
    let off = () => {};
    onFileDrop((paths) =>
      setAttachments((a) => [...a, ...paths.map((path) => ({ kind: "path" as const, name: path.split("/").pop()!, path }))]),
    ).then((fn) => (off = fn));
    return () => off();
  }, []);

  if (!config) return null;

  const configure = (patch: Partial<Config>) =>
    threadId ? call("thread.configure", { threadId, ...patch }) : updateDraft(patch);

  const send = async (steer = false) => {
    const body = text.trim();
    if ((!body && !attachments.length) || sending) return;
    setText("");
    setAttachments([]);
    drafts.delete(key);
    if (threadId) return call("chat.send", { threadId, text: body, attachments, steer });
    setSending(true);
    try {
      await sendDraft(body, attachments);
    } finally {
      setSending(false);
    }
  };

  const addImages = async (files: Iterable<File>) => {
    const images = await Promise.all(
      [...files]
        .filter((f) => f.type.startsWith("image/"))
        .map(async (f) => ({ kind: "image" as const, name: f.name || "image", mediaType: f.type, data: await toBase64(f) })),
    );
    if (images.length) setAttachments((a) => [...a, ...images]);
  };

  const pick = (s: Suggestion) => {
    if (!completion) return;
    const next = text.slice(0, completion.start) + s.insert + text.slice(completion.end);
    const at = completion.start + s.insert.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => input.current?.setSelectionRange(at, at));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (completion && !e.nativeEvent.isComposing) {
      const keys: Record<string, () => void> = {
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        Enter: () => pick(completion.items[completion.index]!),
        Tab: () => pick(completion.items[completion.index]!),
        Escape: dismiss,
      };
      if (keys[e.key] && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        return keys[e.key]!();
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(e.metaKey);
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      call("chat.interrupt", { threadId: threadId! });
    }
  };

  const empty = !text.trim() && !attachments.length;

  return (
    <div className="mx-auto w-full max-w-[768px] px-8 pb-6">
      {threadId && <Questions threadId={threadId} />}
      {threadId && <Approval threadId={threadId} />}
      {threadId && <Queue threadId={threadId} />}
      <div
        onClick={() => input.current?.focus()}
        className="relative rounded-[20px] border border-line bg-raised shadow-[0_10px_40px_-16px_rgba(0,0,0,0.7)]"
      >
        {completion && <CompletionMenu completion={completion} onPick={pick} onHover={setIndex} />}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3.5">
            {attachments.map((a, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-lg bg-hover py-1 pr-1 pl-2 text-[12px] text-dim">
                {a.kind === "image" ? <ImageIcon size={12} /> : <Paperclip size={12} />}
                <span className="max-w-48 truncate">{a.name}</span>
                <button
                  onClick={() => setAttachments((all) => all.filter((_, j) => j !== i))}
                  className="rounded p-0.5 hover:text-ink"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          value={text}
          rows={1}
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addImages(e.clipboardData.files);
            }
          }}
          placeholder={running ? "Queue a follow-up. ⌘↵ sends it now" : threadId ? "Reply" : "What should we work on?"}
          className="block max-h-[360px] min-h-[52px] w-full resize-none bg-transparent px-[18px] pt-4 pb-1 text-[15px] leading-[1.6] text-ink placeholder:text-faint focus:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2.5 pb-2.5">
          <button
            onClick={() => fileInput.current?.click()}
            title="Attach images"
            className="rounded-lg p-1.5 text-faint hover:bg-hover hover:text-ink"
          >
            <Paperclip size={15} strokeWidth={1.75} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addImages(e.target.files);
              e.target.value = "";
            }}
          />
          <ModelChoice config={config} onPick={configure} />
          <EffortPicker config={config} onPick={configure} />
          <AccessPicker config={config} onPick={configure} />
          <div className="flex-1" />
          {thread?.context && <ContextRing used={thread.context.used} window={thread.context.window} />}
          {running && (
            <button
              onClick={() => call("chat.interrupt", { threadId: threadId! })}
              title="Stop (Esc)"
              className="mr-1 flex size-8 items-center justify-center rounded-full border border-line text-dim hover:text-ink"
            >
              <Square size={11} fill="currentColor" />
            </button>
          )}
          <button
            onClick={() => send()}
            disabled={empty || sending}
            title={running ? "Queue (↵)" : "Send (↵)"}
            className="flex size-8 items-center justify-center rounded-full bg-brass text-brass-ink transition hover:brightness-110 disabled:bg-hover disabled:text-faint"
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Queue({ threadId }: { threadId: string }) {
  const queue = useApp((s) => s.queues[threadId]);
  if (!queue?.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {queue.map((q) => (
        <div key={q.id} className="flex items-center gap-3 rounded-2xl border border-line/80 bg-canvas px-4 py-2.5 text-[13.5px]">
          <span className="shrink-0 text-[12px] text-faint">Queued</span>
          <span className="min-w-0 flex-1 truncate text-dim">{q.text || `${q.attachments.length} attachment(s)`}</span>
          <button
            onClick={() => call("chat.steer", { threadId, queuedId: q.id })}
            className="shrink-0 rounded-lg px-2 py-0.5 text-[12.5px] text-dim hover:bg-hover hover:text-ink"
          >
            Send now
          </button>
          <button
            onClick={() => call("chat.unqueue", { threadId, queuedId: q.id })}
            title="Remove"
            className="shrink-0 rounded-md p-1 text-faint hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function MenuContent({ children, side = "top" }: { children: React.ReactNode; side?: "top" | "bottom" }) {
  return (
    <Menu.Portal>
      <Menu.Content
        side={side}
        align="start"
        sideOffset={8}
        className="z-50 max-h-[60vh] min-w-56 overflow-y-auto rounded-2xl border border-line bg-raised p-1.5 shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)]"
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function MenuItem({
  selected,
  label,
  hint,
  onSelect,
}: {
  selected?: boolean;
  label: React.ReactNode;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      onSelect={onSelect}
      className="flex cursor-default items-start gap-2 rounded-xl px-2.5 py-1.5 text-[13px] text-ink outline-none data-highlighted:bg-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block max-w-72 truncate text-[11.5px] text-faint">{hint}</span>}
      </span>
      <span className="mt-0.5 w-3.5 shrink-0">{selected && <Check size={13} className="text-brass" />}</span>
    </Menu.Item>
  );
}

function Trigger({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Menu.Trigger
      title={title}
      className="flex h-[30px] items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] text-ink/80 outline-none transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
    >
      {children}
      <ChevronDown size={13} className="text-faint" />
    </Menu.Trigger>
  );
}

// Switching model keeps the effort when the new model supports it.
function ModelChoice({ config, onPick }: { config: Config; onPick: (p: Partial<Config>) => void }) {
  const models = useApp((s) => s.models);
  return (
    <ModelPicker
      value={config.model}
      onPick={(model) => {
        const efforts = models.find((m) => m.value === model)?.efforts ?? [];
        onPick(efforts.length && !efforts.includes(config.effort) ? { model, effort: DEFAULT_EFFORT } : { model });
      }}
    />
  );
}

// How full the model's context is. Fills brass, warms toward red near the limit.
function ContextRing({ used, window }: { used: number; window: number }) {
  const pct = Math.min(1, used / window);
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const color = pct > 0.85 ? "var(--color-danger)" : pct > 0.6 ? "#d9a35b" : "var(--color-brass)";
  return (
    <span
      title={`Context: ${tokens(used)} of ${tokens(window)} tokens (${Math.round(pct * 100)}%)`}
      className="mr-2 flex items-center gap-1.5 text-[11.5px] text-faint tabular-nums"
    >
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(pct, 0.02))}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      {Math.round(pct * 100)}%
    </span>
  );
}

export function tokens(n: number) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const EFFORTS: Record<Effort, { label: string; hint: string; level: number }> = {
  low: { label: "Low", hint: "Quick answers, light reasoning", level: 1 },
  medium: { label: "Medium", hint: "Balanced speed and depth", level: 2 },
  high: { label: "High", hint: "Thorough. The default", level: 3 },
  xhigh: { label: "Extra high", hint: "Deeper reasoning for hard problems", level: 4 },
  max: { label: "Max", hint: "Everything it has. Slowest", level: 5 },
  ultra: { label: "Ultra", hint: "Codex's longest reasoning", level: 5 },
};

// Five ascending bars, filled up to the effort level.
function EffortMeter({ level }: { level: number }) {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          style={{ height: `${4 + i * 1.6}px` }}
          className={`w-[2.5px] rounded-full ${i <= level ? "bg-brass" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

function EffortPicker({ config, onPick }: { config: Config; onPick: (p: Partial<Config>) => void }) {
  const models = useApp((s) => s.models);
  const efforts = models.find((m) => m.value === config.model)?.efforts ?? [];
  if (!efforts.length) return null;
  const current = EFFORTS[config.effort];
  return (
    <Menu.Root>
      <Trigger title="Effort: how hard the model thinks">
        <EffortMeter level={current.level} />
        {current.label}
      </Trigger>
      <MenuContent>
        <Menu.Label className="px-2.5 pt-1.5 pb-1 text-[11.5px] text-faint">Effort</Menu.Label>
        {efforts.map((e) => (
          <MenuItem
            key={e}
            selected={e === config.effort}
            label={
              <span className="flex items-center gap-2.5">
                <EffortMeter level={EFFORTS[e].level} />
                {EFFORTS[e].label}
              </span>
            }
            hint={EFFORTS[e].hint}
            onSelect={() => onPick({ effort: e })}
          />
        ))}
      </MenuContent>
    </Menu.Root>
  );
}

function AccessPicker({ config, onPick }: { config: Config; onPick: (p: Partial<Config>) => void }) {
  const full = config.access === "full";
  return (
    <Menu.Root>
      <Trigger title="Permissions">
        {full ? <ShieldOff size={13} className="text-faint" /> : <ShieldCheck size={13} className="text-brass" />}
        {full ? "Full access" : "Ask first"}
      </Trigger>
      <MenuContent>
        <MenuItem
          selected={full}
          label="Full access"
          hint="Edits and commands run without asking"
          onSelect={() => onPick({ access: "full" })}
        />
        <MenuItem
          selected={!full}
          label="Ask first"
          hint="Approve commands and edits before they run"
          onSelect={() => onPick({ access: "ask" })}
        />
      </MenuContent>
    </Menu.Root>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
