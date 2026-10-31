import { useEffect, useRef } from "react";
import type { BrowserInput } from "../../../shared/protocol";
import { call, onEvent } from "../rpc";

const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
const button = (value: number) => value === 0 ? "left" : value === 1 ? "middle" : value === 2 ? "right" : "none";

export function BrowserLiveView({ threadId, tabId, image, viewport, title, ready, onResize, onAddress, onNavigate, onError }: {
  threadId: string;
  tabId: string;
  image?: string;
  viewport?: { width: number; height: number };
  title: string;
  ready: boolean;
  onResize: (width: number, height: number) => void;
  onAddress: () => void;
  onNavigate: (action: "reload" | "back" | "forward") => void;
  onError: (message: string) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onResize, onAddress, onNavigate, onError });
  callbacks.current = { onResize, onAddress, onNavigate, onError };
  const size = useRef({ width: 1280, height: 800 });
  const composing = useRef(false);
  const moving = useRef(false);
  const live = useRef(false);

  const send = (input: BrowserInput) => {
    if (!ready) return;
    if (input.type === "mouse" && input.action === "move") {
      if (moving.current) return;
      moving.current = true;
    }
    void call("browser.input", { threadId, tabId, input }).then((result) => {
      if (result.clipboard !== undefined) void navigator.clipboard.writeText(result.clipboard).catch(() => {});
    }).catch((error) => {
      if (input.type !== "release" && input.type !== "mouse") callbacks.current.onError(error.message);
    }).finally(() => { if (input.type === "mouse" && input.action === "move") moving.current = false; });
  };

  useEffect(() => {
    live.current = false;
    return onEvent((event) => {
      if (event.type !== "browser.frame" || event.threadId !== threadId || event.frame.tabId !== tabId || !picture.current) return;
      live.current = true;
      size.current = { width: event.frame.width, height: event.frame.height };
      picture.current.style.width = `${event.frame.width}px`;
      picture.current.style.height = `${event.frame.height}px`;
      picture.current.src = `data:${event.frame.mimeType};base64,${event.frame.image}`;
    });
  }, [threadId, tabId]);

  useEffect(() => {
    if (image && picture.current && !live.current) picture.current.src = `data:image/png;base64,${image}`;
  }, [image, tabId]);

  useEffect(() => {
    const el = surface.current;
    if (!el || !ready) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      callbacks.current.onResize(Math.max(320, Math.min(3840, Math.round(entry.contentRect.width))), Math.max(200, Math.min(2160, Math.round(entry.contentRect.height))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready, tabId]);

  const point = (x: number, y: number) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (x - rect.left) / size.current.width)), y: Math.max(0, Math.min(1, (y - rect.top) / size.current.height)) };
  };

  useEffect(() => {
    const el = surface.current;
    if (!el || !ready) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      // Scrolling also claims control, even before a click.
      keyboard.current?.focus({ preventScroll: true });
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      send({ type: "wheel", ...point(event.clientX, event.clientY), deltaX: Math.max(-10000, Math.min(10000, event.deltaX * unit)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * unit)), modifiers: modifiers(event) });
    };
    const release = () => send({ type: "release" });
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", release);
    return () => { el.removeEventListener("wheel", wheel); window.removeEventListener("blur", release); release(); };
  }, [ready, threadId, tabId]);

  return (
    <div ref={surface} className="browser-live-view" role="application" aria-label="Browser page" tabIndex={0}
      onFocus={() => send({ type: "focus" })}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) send({ type: "release" }); }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        keyboard.current?.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        send({ type: "mouse", action: "down", ...point(e.clientX, e.clientY), button: button(e.button), buttons: e.buttons, clickCount: e.detail > 1 ? 2 : 1, modifiers: modifiers(e) });
      }}
      onPointerMove={(e) => { if (e.buttons || e.currentTarget.contains(document.activeElement)) send({ type: "mouse", action: "move", ...point(e.clientX, e.clientY), button: "none", buttons: e.buttons & 7, modifiers: modifiers(e) }); }}
      onPointerUp={(e) => {
        send({ type: "mouse", action: "up", ...point(e.clientX, e.clientY), button: button(e.button), buttons: e.buttons, clickCount: e.detail > 1 ? 2 : 1, modifiers: modifiers(e) });
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => send({ type: "release" })}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") return;
        if (e.nativeEvent.isComposing || composing.current) return;
        // WebKit's native Unicode input can arrive as Unidentified/Process key events.
        // Let the hidden text field receive that text, then forward its input event.
        if (["Unidentified", "Process", "Dead"].includes(e.key) || (!e.ctrlKey && !e.metaKey && Array.from(e.key).length === 1 && e.key.codePointAt(0)! > 126)) { e.stopPropagation(); return; }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") { e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") { callbacks.current.onAddress(); return; }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") { callbacks.current.onNavigate("reload"); return; }
        if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { callbacks.current.onNavigate(e.key === "ArrowLeft" ? "back" : "forward"); return; }
        const text = !e.ctrlKey && !e.metaKey && !e.altKey ? e.key === "Enter" ? "\r" : e.key.length === 1 ? e.key : undefined : undefined;
        send({ type: "key", action: "down", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e), ...(text ? { text } : {}) });
      }}
      onKeyUp={(e) => {
        if (e.nativeEvent.isComposing || composing.current) return;
        e.preventDefault(); e.stopPropagation();
        send({ type: "key", action: "up", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e) });
      }}
      onPaste={(e) => { e.preventDefault(); e.stopPropagation(); send({ type: "text", text: e.clipboardData.getData("text/plain").slice(0, 20000) }); }}
    >
      <img ref={picture} alt={`Browser page: ${title}`} draggable={false} onLoad={(e) => {
        if (!live.current) {
          const width = viewport?.width ?? surface.current?.clientWidth ?? e.currentTarget.naturalWidth;
          const height = viewport?.height ?? e.currentTarget.naturalHeight * width / e.currentTarget.naturalWidth;
          size.current = { width, height };
          e.currentTarget.style.width = `${width}px`;
          e.currentTarget.style.height = `${height}px`;
        }
      }} />
      <textarea ref={keyboard} className="browser-keyboard" aria-label="Type in browser page" tabIndex={-1} autoComplete="off" autoCapitalize="off" spellCheck={false}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; if (e.data) send({ type: "text", text: e.data }); e.currentTarget.value = ""; }}
        onInput={(e) => { if (!composing.current && e.currentTarget.value) { send({ type: "text", text: e.currentTarget.value }); e.currentTarget.value = ""; } }}
      />
    </div>
  );
}
