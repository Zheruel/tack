import { AlertCircle, Maximize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Item } from "../../../shared/protocol";
import { visualDocument, visualReference, VISUAL_MAX_HEIGHT } from "../../../shared/visual";
import { call } from "../rpc";

type Tool = Extract<Item, { kind: "tool" }>;

export function Visual({ tool, threadId }: { tool: Tool; threadId: string }) {
  const input = (tool.input ?? {}) as { title?: string; html?: string; height?: number };
  const reference = useMemo(() => visualReference(tool.output), [tool.output]);
  const [saved, setSaved] = useState<{ id: string; html?: string; error?: string }>();
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState<number>();
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const channel = useRef(crypto.randomUUID()).current;
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const inlineHeight = useRef<number | undefined>(undefined);
  const title = reference?.title || input.title || "Visualization";
  const html = reference ? (saved?.id === reference.id ? saved.html : undefined) : tool.status === "ok" ? input.html : undefined;
  const doc = useMemo(() => html ? visualDocument(html, channel) : undefined, [html, channel]);

  useEffect(() => {
    if (!reference) return;
    let active = true;
    call("visual.get", { threadId, id: reference.id }).then(
      (html) => active && setSaved({ id: reference.id, html }),
      (error) => active && setSaved({ id: reference.id, error: String(error.message ?? error) }),
    );
    return () => { active = false; };
  }, [reference, threadId]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.tackVisual !== channel) return;
      if (event.data.type === "size" && Number.isFinite(event.data.height)) setHeight(Math.min(VISUAL_MAX_HEIGHT, Math.max(80, event.data.height)));
      if (event.data.type === "ready") setReady(true);
      if (event.data.type === "error" && typeof event.data.message === "string") {
        const message = event.data.message.slice(0, 500);
        setRuntimeErrors((errors) => errors.includes(message) || errors.length >= 5 ? errors : [...errors, message]);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);

  // The very same iframe enters the top layer. Expanding never resets a chart or canvas.
  useLayoutEffect(() => {
    const surface = dialog.current;
    if (!surface) return;
    if (expanded) {
      surface.close();
      surface.showModal();
      wasExpanded.current = true;
    } else if (wasExpanded.current) {
      surface.close();
      surface.setAttribute("open", "");
      expandButton.current?.focus();
      wasExpanded.current = false;
    }
  }, [expanded, doc]);

  const theme = () => {
    const styles = getComputedStyle(window.document.documentElement);
    const variables: Record<string, string> = {};
    for (const [name, token] of Object.entries({ ink: "ink", dim: "dim", faint: "faint", line: "line", raised: "raised", accent: "brass", ok: "ok", danger: "danger", background: "canvas" })) {
      const value = styles.getPropertyValue(`--color-${token}`).trim();
      if (value) variables[`--${name}`] = value;
    }
    frame.current?.contentWindow?.postMessage({ tackVisual: channel, type: "theme", variables }, "*");
  };

  const error = tool.status === "error" ? tool.output || "The visual was interrupted before it could finish." : reference && saved?.id === reference.id ? saved.error : undefined;
  if (error) return (
    <div role="alert" className="my-4 flex gap-3 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-dim">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
      <div><p className="text-ink">Couldn’t display {title.toLowerCase()}.</p><p className="mt-1 break-words">{error}</p></div>
    </div>
  );

  if (!doc) return (
    <div role="status" aria-label={`Creating ${title}`} className="visual-loading my-5 overflow-hidden rounded-xl border border-line/50 p-5">
      <div className="mb-6 flex items-center gap-2 text-[12px] text-faint"><span className="pulse size-1.5 rounded-full bg-brass" />{title}</div>
      <div className="flex h-28 items-end gap-3" aria-hidden="true">
        {[42, 68, 52, 88, 74, 100, 83].map((h, i) => <span key={i} className="visual-loading-bar flex-1 rounded-t-md bg-brass/[0.09]" style={{ height: `${h}%`, animationDelay: `${i * 90}ms` }} />)}
      </div>
    </div>
  );

  return (
    <figure className="visual my-4" aria-label={title} style={expanded ? { height: inlineHeight.current } : undefined}>
      <dialog ref={dialog} open aria-label={title} aria-modal={expanded || undefined} data-expanded={expanded || undefined} className="visual-surface" onCancel={(event) => { event.preventDefault(); setExpanded(false); }}>
        <div className="visual-toolbar">
          <span className="min-w-0 truncate text-[12px] text-faint">{title}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {expanded && <span className="mr-2 hidden text-[11px] text-faint sm:inline">Esc to close</span>}
            <button ref={expandButton} type="button" aria-label={expanded ? "Close expanded visualization" : "Expand visualization"} title={expanded ? "Close (Esc)" : "Expand visualization"} onClick={() => {
              if (!expanded) inlineHeight.current = dialog.current?.getBoundingClientRect().height;
              setExpanded((value) => !value);
            }} className="visual-action">
              {expanded ? <X size={16} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
        <div className="visual-stage">
          <iframe ref={frame} title={title} sandbox="allow-scripts" srcDoc={doc} onLoad={theme} className="visual-frame" style={{ height: height ?? reference?.height ?? input.height ?? 320, opacity: ready ? 1 : 0 }} />
        </div>
        {runtimeErrors.length > 0 && <details className="mx-1 mt-2 text-[12px] text-danger"><summary className="cursor-pointer">This visual reported a rendering error</summary><ul className="mt-1 space-y-1">{runtimeErrors.map((message) => <li key={message} className="break-words font-mono">{message}</li>)}</ul></details>}
      </dialog>
    </figure>
  );
}
