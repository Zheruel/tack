import { ArrowRight, Globe2, Loader2, Maximize2, Minimize2, PenLine, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserPreview, Requests } from "../../../shared/protocol";
import { call, onConnect } from "../rpc";
import { attachBrowserImage, suggestReply, useApp } from "../store";
import { BrowserAnnotation } from "./BrowserAnnotation";
import { BrowserLiveView } from "./BrowserLiveView";

const EMPTY: BrowserPreview = { tabs: [] };
type Command = Requests["browser.command"]["params"];

export function BrowserPane({ threadId }: { threadId: string }) {
  const preview = useApp((s) => s.browsers[threadId]) ?? EMPTY;
  const current = preview.tabs.find((t) => t.tabId === preview.currentTabId);
  const [address, setAddress] = useState("");
  const [newTab, setNewTab] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [annotation, setAnnotation] = useState<{ image: string; url: string; title: string }>();
  const [width, setWidth] = useState(620);
  const [maxWidth, setMaxWidth] = useState(1000);
  const [resizing, setResizing] = useState(false);
  const [watching, setWatching] = useState(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const pane = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingViewport = useRef<{ width: number; height: number } | undefined>(undefined);
  const resizingViewport = useRef(false);
  const stopDrag = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const parent = pane.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || window.innerWidth <= 1100) return;
      const limit = Math.max(360, Math.floor(entry.contentRect.width - 320));
      setMaxWidth(limit);
      setWidth((current) => Math.min(current, limit));
    });
    observer.observe(parent);
    return () => { observer.disconnect(); stopDrag.current?.(); };
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const load = () => call("browser.watch", { threadId, visible: !document.hidden }).then((value) => {
      if (active) {
        useApp.setState((s) => ({ browsers: { ...s.browsers, [threadId]: value } }));
        setWatching(!document.hidden);
      }
    }).catch((e) => { if (active) setError(e.message); });
    void load();
    const off = onConnect(load);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false; mounted.current = false; off();
      clearTimeout(resizeTimer.current);
      document.removeEventListener("visibilitychange", load);
      void call("browser.watch", { threadId, visible: false }).catch(() => {});
    };
  }, [threadId]);

  useEffect(() => { if (!newTab && document.activeElement !== addressInput.current) setAddress(current?.url ?? ""); }, [current?.url, newTab]);

  const command = async (name: Command["name"], input: Command["input"] = {}) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await call("browser.command", { threadId, name, input });
      useApp.setState((s) => ({ browsers: { ...s.browsers, [threadId]: value } }));
      if (mounted.current) setNewTab(false);
      return value;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const navigate = (value = address) => {
    const raw = value.trim();
    if (!raw) return;
    const url = /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^localhost:\d/i.test(raw) ? raw : `http${/^(localhost|127\.)/.test(raw) ? "" : "s"}://${raw}`;
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
    } catch { setError("Enter an HTTP or HTTPS address."); return; }
    setAddress(url);
    void command(newTab || !current ? "preview_open" : "preview_navigate", { url, ...(newTab ? { reuseExistingTab: false } : { tabId: current?.tabId }) });
  };

  const close = () => useApp.setState({ browserOpen: false });
  const tab = current && !newTab;
  const blocked = busy || !!annotation;
  const resizeViewport = (width: number, height: number) => {
    pendingViewport.current = { width, height };
    const flush = () => {
      if (resizeTimer.current || resizingViewport.current || !mounted.current) return;
      resizeTimer.current = setTimeout(async () => {
        resizeTimer.current = undefined;
        const next = pendingViewport.current;
        pendingViewport.current = undefined;
        if (!next || !mounted.current) return;
        resizingViewport.current = true;
        try { await call("browser.resize", { threadId, ...next }); }
        catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
        finally { resizingViewport.current = false; if (pendingViewport.current) flush(); }
      }, 50);
    };
    flush();
  };
  const navigatePage = (action: "reload" | "back" | "forward") => {
    addressInput.current?.focus(); // Return control before requesting a navigation.
    void command("preview_act", { tabId: current?.tabId, action });
  };
  const install = async () => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      await call("browser.install", { threadId });
      const value = await call("browser.get", { threadId });
      useApp.setState((s) => ({ browsers: { ...s.browsers, [threadId]: value } }));
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };

  return (
    <aside ref={pane} className="browser-pane" style={{ flexBasis: width }} data-expanded={expanded || undefined} data-resizing={resizing || undefined} aria-label="Browser">
      <div className="browser-resizer" role="separator" aria-label="Resize browser" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0}
        onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth((w) => Math.max(360, Math.min(maxWidth, w + (e.key === "ArrowLeft" ? 24 : -24)))); } }}
        onPointerDown={(e) => {
          e.preventDefault();
          stopDrag.current?.();
          const handle = e.currentTarget;
          handle.setPointerCapture(e.pointerId);
          setResizing(true);
          const cursor = document.body.style.cursor;
          document.body.style.cursor = "col-resize";
          const start = e.clientX;
          const initial = pane.current?.getBoundingClientRect().width ?? width;
          const move = (event: PointerEvent) => setWidth(Math.max(360, Math.min(maxWidth, initial + start - event.clientX)));
          const stop = () => {
            handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); handle.removeEventListener("lostpointercapture", stop);
            document.body.style.cursor = cursor;
            stopDrag.current = undefined;
            if (mounted.current) setResizing(false);
          };
          stopDrag.current = stop;
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", stop);
          handle.addEventListener("pointercancel", stop);
          handle.addEventListener("lostpointercapture", stop);
        }} />

      <div className="browser-tabbar" data-tauri-drag-region>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs" onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)')];
          if (!tabs.length) return;
          e.preventDefault();
          const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next]?.focus();
          tabs[next]?.click();
        }}>
          {preview.tabs.map((t) => (
            <div className={`browser-tab ${!newTab && current?.tabId === t.tabId ? "is-active" : ""}`} key={t.tabId}>
              <button role="tab" aria-selected={!newTab && current?.tabId === t.tabId} aria-disabled={blocked} tabIndex={!newTab && current?.tabId === t.tabId ? 0 : -1} onClick={() => { if (blocked) return; setNewTab(false); void command("preview_open", { tabId: t.tabId }); }}>
                <Globe2 size={13} /><span>{t.title || hostname(t.url)}</span>
              </button>
              <button className="browser-tab-close" aria-label={`Close ${t.title || "tab"}`} disabled={blocked} onClick={() => void command("preview_close", { tabId: t.tabId })}><X size={11} /></button>
            </div>
          ))}
          {(newTab || !preview.tabs.length) && <div className="browser-tab is-active"><button role="tab" aria-selected="true"><Globe2 size={13} /><span>New tab</span></button></div>}
        </div>
        <IconButton label="New tab" disabled={blocked} onClick={() => { setNewTab(true); setAddress(""); setError(""); addressInput.current?.focus(); }}><Plus size={15} /></IconButton>
        <div className="browser-window-actions">
          <IconButton label={expanded ? "Restore pane" : "Expand browser"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton>
          <IconButton label="Hide browser" onClick={close}><X size={16} /></IconButton>
        </div>
      </div>

      <form className="browser-navigation" onSubmit={(e) => { e.preventDefault(); if (!blocked) navigate(); }}>
        <IconButton label="Reload page" disabled={!tab || blocked} onClick={() => navigatePage("reload")}>{busy ? <Loader2 size={15} className="browser-spin" /> : <RefreshCw size={15} />}</IconButton>
        <div className="browser-address">
          <input ref={addressInput} aria-label="Page URL" placeholder="Type a URL" value={address} readOnly={!!annotation} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={(e) => { if (e.key === "Escape") { setAddress(current?.url ?? ""); e.currentTarget.blur(); } }} spellCheck={false} autoComplete="off" />
          <button type="submit" className="browser-go" aria-label="Go to URL" disabled={blocked || preview.needsInstall || !address.trim()}><ArrowRight size={14} /></button>
        </div>
        <button type="button" className={`browser-icon browser-pen ${annotation ? "is-active" : ""}`} title="Draw on page" aria-label="Draw on page" aria-pressed={!!annotation} disabled={!annotation && (!tab || busy)}
          onClick={async () => {
            if (annotation) { setAnnotation(undefined); return; }
            const value = await command("preview_snapshot", { tabId: current?.tabId });
            if (mounted.current && value?.image && current) setAnnotation({ image: value.image, url: current.url, title: current.title || current.url });
          }}><PenLine size={16} /></button>
      </form>

      {error && <div className="browser-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss browser error"><X size={14} /></button></div>}

      <div className="browser-stage" aria-busy={busy}>
        {busy && <div className="browser-progress" />}
        {preview.needsInstall ? (
          <div className="browser-empty"><GlobeMark /><h2>Set up your browser</h2><p>Download the browser to preview your app<br />and browse alongside your agent.</p><button className="browser-primary" disabled={busy} onClick={install}>{busy ? <Loader2 size={14} className="browser-spin" /> : <Globe2 size={14} />}{busy ? "Setting up…" : "Download browser"}</button></div>
        ) : annotation ? (
          <BrowserAnnotation image={annotation.image} title={annotation.title} onCancel={() => setAnnotation(undefined)} onAttach={(image) => {
            attachBrowserImage(threadId, image, annotation.url);
            setAnnotation(undefined);
            setExpanded(false);
          }} />
        ) : tab ? (
          <BrowserLiveView key={current.tabId} threadId={threadId} tabId={current.tabId} image={preview.image} viewport={preview.viewport} title={current.title || current.url} ready={watching}
            onResize={resizeViewport} onAddress={() => addressInput.current?.focus()} onNavigate={navigatePage} onError={setError} />
        ) : (
          <div className="browser-empty"><GlobeMark /><h2>Browse with Tack</h2><p>Type a URL or ask your agent to open a site.<br />Your agent can read, click, and type.</p>
            <div className="browser-empty-project"><span>Preview your app instead?</span><button className="browser-local" onClick={() => suggestReply(threadId, "Start this project's development server and open it using preview_open. Take a screenshot with preview_snapshot.")}>Open project<ArrowRight size={12} /></button></div>
          </div>
        )}
      </div>
    </aside>
  );
}

function IconButton({ label, children, onClick, disabled }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="browser-icon" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function GlobeMark() {
  return <div className="browser-globe-mark"><Globe2 size={25} strokeWidth={1.3} /></div>;
}

function hostname(url: string) { try { return new URL(url).host; } catch { return "New tab"; } }
