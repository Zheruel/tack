import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUp, Check, CornerUpRight, Folder, GitBranch, GitFork, ListPlus, Paperclip, Search, ShieldCheck, ShieldOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_EFFORT, type Access, type Attachment, type Effort, type Provider } from "../../../shared/protocol";
import { onFileDrop } from "../native";
import { call } from "../rpc";
import { sendDraft, updateDraft, useApp } from "../store";
import { promptSuggestion } from "../suggestions";
import { Approval } from "./Approvals";
import { CompletionMenu, useCommandNames, useCompletion, type Suggestion } from "./Autocomplete";
import { PROVIDER_NAMES } from "./Logos";
import { ModelPicker } from "./ModelPicker";
import { Questions } from "./Questions";

// Keep unsent content and pending sends with their chat, including while it is unmounted.
interface ComposerDraft {
  text: string;
  attachments: Attachment[];
  sending?: boolean;
  error?: string;
  dismissedSuggestion?: string;
  editing?: { id: string; attachments: Attachment[]; draft: { text: string; attachments: Attachment[] } };
}
const drafts = new Map<string, ComposerDraft>();
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
const draftListeners = new Set<() => void>();
const subscribeDrafts = (listener: () => void) => {
  draftListeners.add(listener);
  return () => { draftListeners.delete(listener); };
};
const draftFor = (key: string) => drafts.get(key) ?? emptyDraft;
function changeDraft(key: string, update: (draft: ComposerDraft) => ComposerDraft) {
  drafts.set(key, update(draftFor(key)));
  for (const listener of draftListeners) listener();
}
function restoreDraft(d: ComposerDraft): ComposerDraft {
  if (!d.editing) return d;
  return {
    ...d, ...d.editing.draft,
    attachments: [...d.editing.draft.attachments, ...d.attachments.filter((a) => !d.editing!.attachments.includes(a))],
    editing: undefined, sending: false, error: undefined,
  };
}
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
  const composerRequest = useApp((s) => s.composerRequest);
  const predicted = useApp(useShallow((s) => promptSuggestion(threadId, s)));
  const config: Config | undefined = thread ?? draft;
  const key = threadId ?? DRAFT;
  const cached = useSyncExternalStore(subscribeDrafts, () => draftFor(key));
  const { text, attachments, sending, editing, error } = cached;
  const setText = (value: SetStateAction<string>) => changeDraft(key, (d) => ({ ...d, text: typeof value === "function" ? value(d.text) : value }));
  const setAttachments = (value: SetStateAction<Attachment[]>) => changeDraft(key, (d) => ({ ...d, attachments: typeof value === "function" ? value(d.attachments) : value }));
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = thread?.status === "running";
  const [caret, setCaret] = useState(0);
  const provider: Provider = useApp((s) => s.models.find((m) => m.value === config?.model)?.provider ?? thread?.provider ?? "claude");
  const projectId = thread?.projectId ?? draft?.projectId;
  const { completion, move, dismiss, setIndex } = useCompletion(text, caret, projectId, provider);
  const commandNames = useCommandNames(projectId, provider);
  const mirror = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLButtonElement>(null);
  const [suggestionHeight, setSuggestionHeight] = useState(47);
  const suggestion = predicted && cached.dismissedSuggestion !== predicted.id && !text.length && !attachments.length && !sending && !editing && !error && !completion && composerRequest?.threadId !== threadId ? predicted : undefined;
  const dismissSuggestion = () => {
    if (predicted) changeDraft(key, (d) => ({ ...d, dismissedSuggestion: predicted.id }));
  };
  const acceptSuggestion = () => {
    const current = promptSuggestion(threadId, useApp.getState());
    const draft = draftFor(key);
    if (!suggestion || current?.id !== suggestion.id || current.text !== suggestion.text || draft.text.length || draft.attachments.length || draft.sending || draft.editing || draft.dismissedSuggestion === current.id) return;
    changeDraft(key, (d) => ({ ...d, text: current.text, dismissedSuggestion: current.id }));
    requestAnimationFrame(() => {
      const el = input.current;
      if (el?.dataset.composerKey !== key) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  };
  useEffect(() => {
    const el = ghost.current;
    if (!el) return;
    const measure = () => setSuggestionHeight(Math.max(47, Math.ceil(el.scrollHeight)));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [suggestion?.id, suggestion?.text]);

  // Holding ⌘ turns the steer button into a queue button, since ⌘↵ queues.
  const [queueKey, setQueueKey] = useState(false);
  useEffect(() => {
    const track = (e: KeyboardEvent) => setQueueKey(e.metaKey);
    const clear = () => setQueueKey(false);
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    input.current?.focus();
  }, [key]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [text, key]);

  useEffect(() => {
    if (!composerRequest || composerRequest.threadId !== threadId || !config) return;
    if (useApp.getState().composerRequest !== composerRequest) return;
    const message = composerRequest.text;
    const requestedAttachments = composerRequest.attachments;
    if (requestedAttachments?.length) setAttachments((current) => [...current, ...requestedAttachments]);
    setText((current) => {
      const draft = current.trimEnd();
      if (!draft.trim()) return message;
      return draft === message || draft.endsWith(`\n\n${message}`) ? current : `${draft}\n\n${message}`;
    });
    dismiss();
    useApp.setState({ composerRequest: undefined });
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  }, [composerRequest, threadId, config, dismiss]);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    onFileDrop((paths) => {
      if (!cancelled) setAttachments((a) => [...a, ...paths.map((path) => ({ kind: "path" as const, name: path.split("/").pop()!, path }))]);
    }).then((fn) => cancelled ? fn() : (off = fn));
    return () => { cancelled = true; off(); };
  }, [key]);

  if (!config) return null;

  const configure = (patch: Partial<Config>) =>
    threadId ? call("thread.configure", { threadId, ...patch }) : updateDraft(patch);

  // Sending while the agent works steers it by default; `queue` holds the message until the turn ends.
  const edit = (id: string) => {
    const q = useApp.getState().queues[threadId!]?.find((m) => m.id === id);
    if (!q || q.agents) return;
    if (draftFor(key).sending) return;
    changeDraft(key, (d) => {
      const unsent = restoreDraft(d);
      return {
        ...d,
        editing: { id, attachments: q.attachments, draft: { text: unsent.text, attachments: unsent.attachments } },
        text: q.text,
        attachments: q.attachments,
        error: undefined,
      };
    });
    requestAnimationFrame(() => input.current?.focus());
  };
  const stopEditing = () => {
    changeDraft(key, (d) => d.sending ? d : restoreDraft(d));
  };

  const send = async (queue = false) => {
    const submitted = draftFor(key);
    const body = submitted.text.trim();
    if (submitted.sending || (!body && (!submitted.attachments.length || submitted.editing))) return;
    changeDraft(key, (d) => ({ ...d, sending: true, error: undefined }));
    try {
      if (submitted.editing && threadId) {
        await call("chat.edit", { threadId, queuedId: submitted.editing.id, text: body });
        changeDraft(key, (d) => d.text === submitted.text
          ? restoreDraft(d)
          : { ...d, sending: false });
      } else {
        let createdId: string | undefined;
        if (threadId) await call("chat.send", { threadId, text: body, attachments: submitted.attachments, steer: !queue });
        else createdId = await sendDraft(body, submitted.attachments);
        changeDraft(key, (d) => ({
          ...d,
          text: d.text === submitted.text ? "" : d.text,
          attachments: d.attachments.filter((a) => !submitted.attachments.includes(a)),
          sending: false,
        }));
        // Text or images added while the first send was pending follow into the new chat.
        const remaining = draftFor(key);
        if (createdId && useApp.getState().activeThreadId === createdId && (remaining.text || remaining.attachments.length)) {
          changeDraft(createdId, (d) => ({ ...d, text: [remaining.text, d.text].filter(Boolean).join("\n\n"), attachments: [...remaining.attachments, ...d.attachments] }));
          changeDraft(key, () => emptyDraft);
        }
      }
    } catch (e) {
      changeDraft(key, (d) => ({ ...d, sending: false, error: e instanceof Error ? e.message : String(e) }));
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
    if (suggestion && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === "Tab") { e.preventDefault(); acceptSuggestion(); return; }
      if (e.key === "Escape") { e.preventDefault(); dismissSuggestion(); return; }
    }
    // A fully typed "/command" sends on Enter, as in Claude Code, rather than completing itself again.
    const picked = completion?.items[completion.index];
    const typedInFull = !!completion && !!picked?.label.startsWith("/") && picked.insert.trimEnd() === text.slice(completion.start, completion.end);
    if (completion && !e.nativeEvent.isComposing && !(e.key === "Enter" && typedInFull)) {
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
    const queue = threadId ? useApp.getState().queues[threadId]?.filter((m) => !m.agents) ?? [] : [];
    if (e.key === "Enter" && e.metaKey && e.shiftKey && !e.nativeEvent.isComposing) {
      // Sends the oldest queued message as a steer and leaves the draft alone.
      e.preventDefault();
      if (queue[0]) call("chat.steer", { threadId: threadId!, queuedId: queue[0].id });
    } else if (e.key === "ArrowUp" && e.altKey && !editing && queue.length && input.current?.selectionStart === 0 && input.current.selectionEnd === 0) {
      e.preventDefault();
      edit(queue[queue.length - 1]!.id);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(e.metaKey);
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      stopEditing();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      call("chat.interrupt", { threadId: threadId! });
    }
  };

  const empty = !text.trim() && !attachments.length;
  const stopping = running && empty;

  return (
    <div className="thread-composer mx-auto w-full max-w-[768px] px-8 pb-4">
      {threadId && <Questions threadId={threadId} />}
      {threadId && <Approval threadId={threadId} />}
      {threadId && <Queue threadId={threadId} editing={editing?.id} onEdit={edit} />}
      {editing && <div className="px-1 pb-1.5 text-[12px] text-faint">Editing a queued message. ↵ saves, Esc cancels.</div>}
      {error && <p role="alert" className="px-1 pb-2 text-[12px] text-danger">{error}</p>}
      <div className="relative">
        {completion && <CompletionMenu completion={completion} onPick={pick} onHover={setIndex} />}
        <div
          // Portaled menus bubble clicks through React; refocusing then dismisses them.
          onClick={(e) => e.currentTarget.contains(e.target as Node) && input.current?.focus()}
          className="composer-card relative z-10 rounded-2xl"
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3.5">
              {attachments.map((a, i) => (
                <span key={i} className="group relative">
                  {a.kind === "image" ? (
                    <img
                      src={`data:${a.mediaType};base64,${a.data}`}
                      alt={a.name}
                      title={a.name}
                      className="size-16 rounded-lg object-cover shadow-[inset_0_0_0_1px_rgb(255_255_255/8%)]"
                    />
                  ) : (
                    <span className="flex h-7 items-center gap-1.5 rounded-lg bg-ink/[0.07] pr-6 pl-2 text-[12.5px] text-dim">
                      <Paperclip size={12} />
                      <span className="max-w-48 truncate">{a.name}</span>
                    </span>
                  )}
                  <button
                    disabled={editing?.attachments.includes(a)}
                    onClick={() => setAttachments((all) => all.filter((_, j) => j !== i))}
                    title={editing?.attachments.includes(a) ? "Queued images cannot be edited" : "Remove"}
                    className={`absolute flex size-5 items-center justify-center rounded-full text-dim hover:text-ink ${
                      a.kind === "image" ? "-top-1.5 -right-1.5 bg-raised opacity-0 shadow group-hover:opacity-100" : "top-1 right-1"
                    }`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative px-4 pt-3.5 pb-1">
            {/* The text is drawn here so typed /commands and @files can be coloured; the textarea above it stays transparent but takes the typing. */}
            <div
              ref={mirror}
              aria-hidden
              className="pointer-events-none absolute inset-x-4 top-3.5 bottom-1 overflow-hidden text-[14.5px] leading-[1.625] tracking-[-0.003em] break-words whitespace-pre-wrap text-ink [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {highlightCommands(text, commandNames)}
              {"\n"}
            </div>
            <textarea
              ref={input}
              data-composer-key={key}
              aria-label={threadId ? "Message" : "New message"}
              value={text}
              rows={2}
              autoFocus
              onChange={(e) => {
                dismissSuggestion();
                setText(e.target.value);
                setCaret(e.target.selectionStart);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  addImages(e.clipboardData.files);
                }
              }}
              placeholder={suggestion ? "" : running ? "Steer the agent. ⌘↵ queues it for after. ⌥↑ edits the last queued" : threadId ? "Reply" : "Ask anything. @ files, / commands"}
              style={suggestion ? { minHeight: suggestionHeight } : undefined}
              className="block max-h-[300px] min-h-[47px] w-full resize-none bg-transparent p-0 text-[14.5px] leading-[1.625] tracking-[-0.003em] text-transparent caret-ink placeholder:text-faint focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            />
            {suggestion && (
              <>
                <button ref={ghost} type="button" tabIndex={-1} className="composer-suggestion" aria-label={`Use suggested prompt: ${suggestion.text}`} onClick={acceptSuggestion}>{suggestion.text}</button>
                <button type="button" tabIndex={-1} className="composer-suggestion-dismiss" aria-label="Dismiss suggested prompt" title="Dismiss suggestion" onClick={dismissSuggestion}><X size={13} /></button>
              </>
            )}
          </div>
          <div className="composer-controls flex items-center gap-1 px-2 pb-2">
            <button
              onClick={() => fileInput.current?.click()}
              title={editing ? "Attach images to your next message" : "Attach images"}
              aria-label="Attach images"
              className="flex size-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
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
            <div className="flex-1" />
            <ModelChoice config={config} onPick={configure} />
            <EffortPicker config={config} onPick={configure} />
            <ContextMeter context={thread?.context} provider={provider} />
            {/* One button: stop while the agent works and the box is empty, send otherwise. */}
            {stopping ? (
              <button
                onClick={() => call("chat.interrupt", { threadId: threadId! })}
                title="Stop (Esc)"
                aria-label="Stop"
                className="ml-1 flex size-8 cursor-pointer items-center justify-center rounded-full bg-danger/90 text-white transition duration-150 hover:scale-105 hover:bg-danger"
              >
                <svg viewBox="0 0 8 8" className="size-2">
                  <rect width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                onClick={(e) => send(e.metaKey)}
                disabled={empty || sending}
                title={running ? "Steer (↵) · Queue (⌘↵)" : "Send (↵)"}
                aria-label={running ? (queueKey ? "Queue" : "Steer") : "Send"}
                className="ml-1 flex size-8 cursor-pointer items-center justify-center rounded-full bg-brass text-brass-ink transition duration-150 hover:scale-105 hover:brightness-110 disabled:cursor-default disabled:bg-ink/[0.12] disabled:text-faint disabled:hover:scale-100 disabled:hover:brightness-100"
              >
                {running ? queueKey ? <ListPlus size={16} strokeWidth={2.25} /> : <CornerUpRight size={16} strokeWidth={2.25} /> : <ArrowUp size={16} strokeWidth={2.25} />}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-0.5 px-1.5 pt-1.5">
        <WorkspaceMenu />
        {projectId && <BranchPicker key={projectId} projectId={projectId} />}
        <div className="flex-1" />
        <AccessMenu config={config} onPick={configure} />
      </div>
    </div>
  );
}

function Queue({ threadId, editing, onEdit }: { threadId: string; editing?: string; onEdit: (id: string) => void }) {
  const all = useApp((s) => s.queues[threadId]);
  const held = useApp((s) => s.held[threadId]);
  // Sub-agent reports wait their turn quietly; only what you queued shows.
  const queue = useMemo(() => all?.filter((q) => !q.agents), [all]);
  if (!queue?.length) return null;
  return (
    <div className="flex flex-col items-end gap-2 pb-3">
      {held && (
        <div className="flex items-center gap-2 text-[12px] text-faint">
          Stopped. Queued messages are paused.
          <button onClick={() => call("chat.resume", { threadId })} className="rounded-md px-1.5 py-0.5 text-dim hover:bg-hover hover:text-ink">
            Resume
          </button>
        </div>
      )}
      {queue.map((q) => (
        <div
          key={q.id}
          className={`flex max-w-[80%] items-center gap-1.5 rounded-2xl border border-dashed py-1.5 pr-1.5 pl-3 text-[13.5px] text-dim ${q.id === editing ? "border-brass/70" : "border-faint/45"}`}
        >
          <span className="shrink-0 text-[11.5px] text-faint">Next</span>
          <span
            onClick={() => onEdit(q.id)}
            title="Edit"
            className="min-w-0 cursor-text truncate"
          >
            {q.text || `${q.attachments.length} attachment(s)`}
          </span>
          <button
            onClick={() => call("chat.steer", { threadId, queuedId: q.id })}
            className="h-[22px] shrink-0 rounded-md px-1.5 text-[12px] text-faint hover:bg-hover hover:text-ink"
          >
            Send now
          </button>
          <button
            onClick={() => call("chat.unqueue", { threadId, queuedId: q.id })}
            title="Remove"
            aria-label="Remove"
            className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function MenuContent({
  children,
  side = "top",
  align = "start",
  className = "min-w-56",
}: {
  children: React.ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <Menu.Portal>
      <Menu.Content
        side={side}
        align={align}
        sideOffset={8}
        className={`menu-glass z-50 max-h-[60vh] overflow-y-auto p-1 outline-none select-none ${className}`}
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
  icon,
  badge,
  disabled,
  onSelect,
}: {
  selected?: boolean;
  label: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  badge?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={`flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13.5px] text-ink outline-none data-disabled:text-faint data-highlighted:bg-ink/[0.08] ${
        selected ? "bg-ink/[0.08]" : ""
      }`}
    >
      {icon && <span className="flex shrink-0 text-faint">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          {label}
          {badge && <span className="text-[11.5px] text-faint">{badge}</span>}
        </span>
        {hint && <span className="block max-w-72 truncate text-[11.5px] leading-snug text-faint">{hint}</span>}
      </span>
      <Check size={14} className={`shrink-0 ${selected ? "" : "invisible"}`} />
    </Menu.Item>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <Menu.Label className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-faint">{children}</Menu.Label>;
}

// The quiet buttons under the card: where the agent works and how much it may do.
const under =
  "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-faint outline-none transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink";

function WorkspaceMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger className={under}>
        <Folder size={13} strokeWidth={1.75} />
        Current checkout
      </Menu.Trigger>
      <MenuContent className="w-60">
        <MenuLabel>Workspace</MenuLabel>
        <MenuItem selected label="Current checkout" onSelect={() => {}} />
        <MenuItem disabled label="New worktree" badge="Soon" icon={<GitFork size={14} />} onSelect={() => {}} />
      </MenuContent>
    </Menu.Root>
  );
}

// Switches the project's checkout. Git refuses when local changes would be lost; its message shows here.
function BranchPicker({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  const load = () => call("git.branches", { projectId }).then(setState, () => {});
  useEffect(() => {
    load();
  }, [projectId]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError("");
    load();
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = state.branches.filter((b) => b.toLowerCase().includes(q));
  useEffect(() => setActive(0), [q]);

  const pick = async (branch: string) => {
    if (branch === state.current) return setOpen(false);
    try {
      await call("git.checkout", { projectId, branch });
      setState((s) => ({ ...s, current: branch }));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!state.current && !state.branches.length) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={under}>
        <GitBranch size={13} strokeWidth={1.75} />
        <span className="max-w-48 truncate">{state.current ?? "Detached"}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const by = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + by + shown.length) % Math.max(shown.length, 1));
            } else if (e.key === "Enter" && shown[active]) {
              e.preventDefault();
              pick(shown[active]!);
            }
          }}
          className="menu-glass z-50 flex max-h-[320px] w-64 flex-col p-1 outline-none select-none"
        >
          <label className="mx-1.5 mt-1 mb-1 flex items-center gap-1.5 border-b border-white/[0.08] pb-1.5 transition-colors focus-within:border-brass">
            <Search size={14} className="shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches"
              className="h-6 min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.map((b, i) => (
              <div
                key={b}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => pick(b)}
                className={`flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13.5px] text-ink ${i === active ? "bg-ink/[0.08]" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{b}</span>
                <Check size={14} className={`shrink-0 ${b === state.current ? "" : "invisible"}`} />
              </div>
            ))}
            {!shown.length && <p className="px-2 py-2 text-[12.5px] text-faint">No branches found</p>}
          </div>
          {error && <p className="mx-1 mt-1 rounded-md bg-danger/10 px-2 py-1.5 text-[12px] leading-snug text-danger">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const ACCESS: Record<Access, { label: string; hint: string; Icon: typeof ShieldOff }> = {
  ask: { label: "Ask first", hint: "Approve commands and edits before they run.", Icon: ShieldCheck },
  full: { label: "Full access", hint: "Allow commands and edits without prompts.", Icon: ShieldOff },
};

// T3's segmented permissions control, with the chosen mode spelled out below it.
function Permissions({ access, onPick }: { access: Access; onPick: (a: Access) => void }) {
  return (
    <>
      <MenuLabel>Permissions</MenuLabel>
      <div className="mx-2 my-0.5 flex gap-0.5 rounded-lg bg-black/20 p-0.5">
        {(Object.keys(ACCESS) as Access[]).map((a) => {
          const { Icon, label } = ACCESS[a];
          return (
            <button
              key={a}
              title={label}
              aria-label={label}
              aria-pressed={a === access}
              onClick={() => onPick(a)}
              className={`flex h-6 flex-1 items-center justify-center rounded-md transition-colors ${
                a === access ? "bg-ink/[0.13] text-ink" : "text-faint hover:bg-hover hover:text-ink"
              }`}
            >
              <Icon size={14} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
      <div className="flex min-h-[52px] flex-col gap-0.5 px-2 py-1.5">
        <span className="text-[13px] font-medium text-ink">{ACCESS[access].label}</span>
        <span className="text-[11.5px] leading-snug text-faint">{ACCESS[access].hint}</span>
      </div>
    </>
  );
}

function AccessMenu({ config, onPick }: { config: Config; onPick: (p: Partial<Config>) => void }) {
  const { Icon, label } = ACCESS[config.access];
  return (
    <Menu.Root>
      <Menu.Trigger className={under} title="Permissions">
        <Icon size={13} strokeWidth={1.75} />
        {label}
      </Menu.Trigger>
      <MenuContent align="end" className="w-72">
        <Permissions access={config.access} onPick={(access) => onPick({ access })} />
      </MenuContent>
    </Menu.Root>
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

// How full the model's context is. Hovering shows the numbers and the provider's plan limits.
function ContextMeter({ context, provider }: { context?: { used: number; window: number }; provider: Provider }) {
  const limits = useApp((s) => s.limits[provider]) ?? [];
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? 120 : 160);
  };
  const pct = context ? Math.min(1, context.used / context.window) : 0;
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Context and usage"
        onPointerEnter={() => hover(true)}
        onPointerLeave={() => hover(false)}
        className="flex size-7 items-center justify-center rounded-lg outline-none hover:bg-hover data-[state=open]:bg-hover"
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2" />
          {context && (
            <circle
              cx="8"
              cy="8"
              r={r}
              fill="none"
              stroke={meterColor(pct * 100)}
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - Math.max(pct, 0.02))}
              className="transition-[stroke-dashoffset] duration-500"
            />
          )}
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          onPointerEnter={() => hover(true)}
          onPointerLeave={() => hover(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="menu-glass z-50 flex w-64 flex-col gap-3 p-3 outline-none select-none"
        >
          <Meter
            label="Context window"
            percent={pct * 100}
            note={context ? `${tokens(context.used)} of ${tokens(context.window)} tokens` : "Fills as the conversation grows"}
          />
          {limits.length > 0 && (
            <>
              <div className="h-px bg-white/[0.07]" />
              <div className="-mb-1 text-[11.5px] font-medium text-faint">{PROVIDER_NAMES[provider]} plan usage</div>
              {limits.map((l) => (
                <Meter key={l.kind} label={l.label} percent={l.percent} note={l.resetsAt ? resetsIn(l.resetsAt) : undefined} />
              ))}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Meter({ label, percent, note }: { label: string; percent: number; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-ink">{label}</span>
        <span className="text-dim tabular-nums">{Math.round(percent)}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
        <div
          style={{ width: `${percent > 0 ? Math.min(100, Math.max(percent, 1)) : 0}%`, background: meterColor(percent) }}
          className="h-full rounded-full transition-[width] duration-500"
        />
      </div>
      {note && <span className="text-[11.5px] text-faint">{note}</span>}
    </div>
  );
}

// Brass, warming toward red near the limit.
const meterColor = (percent: number) => (percent > 85 ? "var(--color-danger)" : percent > 60 ? "#d9a35b" : "var(--color-brass)");

function resetsIn(at: number) {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (mins < 60) return `Resets in ${mins}m`;
  if (mins < 24 * 60) return `Resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `Resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export function tokens(n: number) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const EFFORTS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

// The effort sits beside the model as a muted word.
function EffortPicker({ config, onPick }: { config: Config; onPick: (p: Partial<Config>) => void }) {
  const models = useApp((s) => s.models);
  const efforts = models.find((m) => m.value === config.model)?.efforts ?? [];
  if (!efforts.length) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        title="Reasoning effort"
        className="-ml-1.5 flex h-7 items-center rounded-lg px-1.5 text-[13.5px] text-faint outline-none transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
      >
        {EFFORTS[config.effort]}
      </Menu.Trigger>
      <MenuContent align="end" className="w-60">
        <MenuLabel>Reasoning</MenuLabel>
        {efforts.map((e) => (
          <MenuItem
            key={e}
            selected={e === config.effort}
            label={EFFORTS[e]}
            badge={e === DEFAULT_EFFORT ? "Default" : undefined}
            onSelect={() => onPick({ effort: e })}
          />
        ))}
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

// Splits the text so each typed "/command" that exists is wrapped for colouring.
function highlightCommands(text: string, names: Set<string>) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  // Known /commands and finished @file mentions are coloured text, as in T3; widths stay unchanged so the caret lines up.
  for (const m of text.matchAll(/(^|\s)([/@])([^\s@]+)(?=\s|$)/g)) {
    const mention = m[2] === "@";
    if (!mention && !names.has(m[3]!)) continue;
    if (mention && m.index! + m[0].length === text.length) continue;
    const start = m.index! + m[1]!.length;
    const end = start + m[3]!.length + 1;
    parts.push(
      text.slice(last, start),
      <span key={start} className={mention ? "text-[#8fb3d9]" : "text-brass"}>
        {text.slice(start, end)}
      </span>,
    );
    last = end;
  }
  parts.push(text.slice(last));
  return parts;
}
