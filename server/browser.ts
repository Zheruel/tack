import { z } from "zod";
import type { Browser, BrowserContext, Page } from "playwright";
import { isolatedChromium } from "./chromium";
import type { BrowserFrame, BrowserInput, BrowserPreview } from "../shared/protocol";
import { BrowserRefs } from "./browser-snapshot";
import { browserInput, BrowserView } from "./browser-view";
export type { BrowserPreview } from "../shared/protocol";

const tabId = z.string().max(100).optional().describe("Tab ID returned by preview_open; defaults to the current tab");
const timeoutMs = z.number().int().min(100).max(30000).optional();
const target = { tabId };

export const BROWSER_TOOLS = {
  preview_status: { description: "List this thread's isolated browser tabs and current page.", input: target },
  preview_open: { description: "Open or reuse a thread-owned headless browser tab. Only HTTP(S) URLs are supported.", input: { ...target, url: z.string().max(4096).optional(), reuseExistingTab: z.boolean().optional() } },
  preview_navigate: { description: "Navigate a thread-owned tab to an HTTP(S) URL, including relative URLs.", input: { ...target, url: z.string().max(4096), timeoutMs } },
  preview_snapshot: { description: "Inspect the accessibility tree and visible interactive elements. Refs expire on navigation or the next snapshot. Set includeImage to see the screenshot.", input: { ...target, includeImage: z.boolean().optional() } },
  preview_act: { description: "Act on a current snapshot ref using locator='aria-ref=<ref>', use page keyboard/scroll, or reload/back/forward. Take a fresh snapshot after changes.", input: { ...target, action: z.enum(["click", "type", "select", "press", "scroll", "hover", "check", "uncheck", "reload", "back", "forward"]), locator: z.string().max(200).optional(), text: z.string().max(20000).optional(), clear: z.boolean().optional(), values: z.array(z.string().max(1000)).max(100).optional(), key: z.string().max(100).optional(), deltaX: z.number().min(-10000).max(10000).optional(), deltaY: z.number().min(-10000).max(10000).optional(), timeoutMs } },
  preview_evaluate: { description: "Evaluate JavaScript in the owned page. Can modify the page; result must be JSON-serializable.", input: { ...target, expression: z.string().max(20000), timeoutMs } },
  preview_close: { description: "Close a thread-owned browser tab.", input: target },
} as const;

export type BrowserToolName = keyof typeof BROWSER_TOOLS;
export type BrowserContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };
export type BrowserResult = { content: BrowserContent[]; isError?: boolean };
type Tab = { page: Page; refs: BrowserRefs; view: BrowserView; image?: string; title: string };
type Thread = { context: BrowserContext; tabs: Map<string, Tab>; current?: string; human?: string };

const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_TABS = 10;
const textResult = (value: unknown): BrowserResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const errorResult = (error: unknown): BrowserResult => ({ ...textResult(error instanceof Error ? error.message : String(error)), isError: true });
const aborted = () => new Error("Browser operation cancelled.");

function httpUrl(url: string, base?: string): string {
  let parsed: URL;
  try { parsed = base ? new URL(url, base) : new URL(url); } catch { throw new Error("Invalid URL. Supply an absolute HTTP(S) URL or a relative URL on an existing page."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) URLs are allowed.");
  return parsed.href;
}

export class BrowserService {
  constructor(private onChange?: (threadId: string, preview: BrowserPreview) => void) {}
  private browser?: Promise<Browser>;
  private threads = new Map<string, Thread>();
  private queues = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<(preview: BrowserPreview) => void>>();
  private viewers = new Map<string, Map<string, (frame: BrowserFrame) => void>>();
  private viewports = new Map<string, { width: number; height: number }>();
  private streamQueues = new Map<string, Promise<void>>();
  private closed = false;

  private async launch(): Promise<Browser> {
    if (!this.browser) {
      const pending = isolatedChromium().launch({ headless: true, chromiumSandbox: true }).catch((error: unknown) => {
        if (this.browser === pending) this.browser = undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (/executable doesn't exist|browserType\.launch:.*executable|chromium.*not found/i.test(message)) throw new Error("Playwright Chromium is missing. Install it with `bunx playwright install chromium` on the server, then retry.");
        throw error;
      });
      this.browser = pending;
      void pending.then((browser) => browser.on("disconnected", () => {
        if (this.browser !== pending) return;
        this.browser = undefined;
        const ids = [...this.threads.keys()];
        this.threads.clear();
        for (const id of ids) this.emit(id);
      }), () => {});
    }
    return this.browser;
  }

  private async thread(id: string): Promise<Thread> {
    const existing = this.threads.get(id);
    if (existing) return existing;
    const browser = await this.launch();
    if (this.closed) throw new Error("Browser service is disposed.");
    const context = await browser.newContext({ viewport: this.viewports.get(id) ?? { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block" });
    if (this.closed) { await context.close(); throw new Error("Browser service is disposed."); }
    // Block non-web document navigation, including redirects, frames and popups.
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !/^https?:\/\//i.test(request.url())) return route.abort();
      return route.continue();
    });
    const thread: Thread = { context, tabs: new Map() };
    this.threads.set(id, thread);
    return thread;
  }

  private async clearRefs(tab: Tab) {
    tab.refs.clear();
  }

  private emit(id: string) {
    const preview = this.getPreview(id);
    try { this.onChange?.(id, preview); } catch { /* A disconnected UI must not break browser operations. */ }
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(preview); } catch { /* A preview subscriber must not break browser operations. */ }
    }
    this.syncStreams(id);
  }

  getPreview(threadId: string): BrowserPreview {
    const thread = this.threads.get(threadId);
    const tabs = [...(thread?.tabs ?? [])].filter(([, tab]) => !tab.page.isClosed()).map(([tabId, tab]) => ({ tabId, url: tab.page.url(), title: tab.title }));
    const image = thread?.current ? thread.tabs.get(thread.current)?.image : undefined;
    const viewport = thread?.current ? thread.tabs.get(thread.current)?.page.viewportSize() : this.viewports.get(threadId);
    return { tabs, ...(thread?.current ? { currentTabId: thread.current } : {}), ...(image ? { image } : {}), ...(viewport ? { viewport } : {}) };
  }

  private status(threadId: string) {
    const { image: _image, ...summary } = this.getPreview(threadId);
    return summary;
  }

  subscribe(threadId: string, listener: (preview: BrowserPreview) => void): () => void {
    let listeners = this.listeners.get(threadId);
    if (!listeners) this.listeners.set(threadId, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(threadId); };
  }

  watch(threadId: string, viewerId: string, listener: (frame: BrowserFrame) => void): () => void {
    let viewers = this.viewers.get(threadId);
    if (!viewers) this.viewers.set(threadId, viewers = new Map());
    viewers.set(viewerId, listener);
    this.syncStreams(threadId);
    return () => {
      viewers.delete(viewerId);
      if (!viewers.size) this.viewers.delete(threadId);
      void this.release(threadId, viewerId);
      this.syncStreams(threadId);
    };
  }

  private syncStreams(threadId: string) {
    const previous = this.streamQueues.get(threadId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const thread = this.threads.get(threadId);
      if (!thread) return;
      for (const [tabId, tab] of thread.tabs) {
        if (tabId === thread.current && this.viewers.get(threadId)?.size) await tab.view.start().catch(() => {});
        else await tab.view.stop();
      }
    });
    this.streamQueues.set(threadId, work);
    void work.finally(() => { if (this.streamQueues.get(threadId) === work) this.streamQueues.delete(threadId); });
  }

  private enqueue<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const work = (this.queues.get(threadId) ?? Promise.resolve()).catch(() => {}).then(run);
    const tail = work.then(() => {}, () => {});
    this.queues.set(threadId, tail);
    void tail.then(() => { if (this.queues.get(threadId) === tail) this.queues.delete(threadId); });
    return work;
  }

  async resize(threadId: string, width: number, height: number) {
    const size = z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(200).max(2160) }).parse({ width, height });
    this.viewports.set(threadId, size);
    await this.enqueue(threadId, async () => {
      const thread = this.threads.get(threadId);
      const tab = thread?.current ? thread.tabs.get(thread.current) : undefined;
      if (!tab || tab.page.isClosed()) return;
      const current = tab.page.viewportSize();
      if (current?.width === width && current.height === height) return;
      tab.refs.clear();
      tab.image = undefined;
      await tab.page.setViewportSize(size);
      this.emit(threadId);
    });
  }

  async input(threadId: string, tabId: string, viewerId: string, raw: BrowserInput): Promise<{ clipboard?: string }> {
    const input = browserInput.parse(raw) as BrowserInput;
    if (input.type === "release") { await this.release(threadId, viewerId); return {}; }
    const thread = this.threads.get(threadId);
    const tab = thread?.tabs.get(tabId);
    if (!thread || !tab || thread.current !== tabId || tab.page.isClosed()) throw new Error("This browser tab is no longer active.");
    if (thread.human && thread.human !== viewerId) throw new Error("Another viewer controls this page.");
    if (!thread.human) {
      thread.human = viewerId; // Reserve before draining agent work; queued agent writes cannot interleave.
      for (const tab of thread.tabs.values()) tab.refs.clear();
    }
    return this.enqueue(threadId, async () => {
      if (thread.human !== viewerId || thread.current !== tabId) throw new Error("Browser control changed. Click the page to continue.");
      return tab.view.input(input);
    });
  }

  private async release(threadId: string, viewerId: string) {
    const thread = this.threads.get(threadId);
    if (thread?.human !== viewerId) return;
    await this.enqueue(threadId, async () => {
      if (thread.human !== viewerId) return;
      await Promise.allSettled([...thread.tabs.values()].map((tab) => tab.view.release()));
      for (const tab of thread.tabs.values()) tab.refs.clear();
      thread.human = undefined;
    });
  }

  private async closeContext(id: string) {
    const thread = this.threads.get(id);
    if (!thread) return;
    this.threads.delete(id);
    await thread.context.close().catch(() => {});
    this.emit(id);
  }

  async closeThread(threadId: string): Promise<void> {
    // Wait for an in-flight creation too, then close its context.
    await this.closeContext(threadId);
    await this.queues.get(threadId)?.catch(() => {});
    await this.closeContext(threadId);
    this.listeners.delete(threadId);
    this.viewers.delete(threadId);
    this.viewports.delete(threadId);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.threads.keys()].map((id) => this.closeContext(id)));
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([...this.threads.keys()].map((id) => this.closeContext(id)));
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.then((b) => b.close()).catch(() => {});
    this.listeners.clear();
    this.viewers.clear();
    this.viewports.clear();
  }

  async execute(threadId: string, name: string, input: unknown, signal?: AbortSignal, viewerId?: string): Promise<BrowserResult> {
    if (this.closed) return errorResult("Browser service is disposed.");
    if (!threadId || threadId.length > 200) return errorResult("Invalid thread ID.");
    if (!Object.hasOwn(BROWSER_TOOLS, name)) return errorResult(`Unknown browser tool: ${name}`);
    const tool = BROWSER_TOOLS[name as BrowserToolName];
    const parsed = z.object(tool.input).safeParse(input ?? {});
    if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.message}`);
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.queues.set(threadId, tail);
    void tail.then(() => { if (this.queues.get(threadId) === tail) this.queues.delete(threadId); });
    try {
      if (signal?.aborted) throw aborted();
      if (signal) {
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(aborted()); signal.addEventListener("abort", onAbort, { once: true }); });
        try { await Promise.race([previous.catch(() => {}), cancelled]); }
        finally { signal.removeEventListener("abort", onAbort); }
      } else await previous.catch(() => {});
      if (signal?.aborted) throw aborted();
      if (this.closed) throw new Error("Browser service is disposed.");
      const owner = this.threads.get(threadId)?.human;
      if (owner && owner !== viewerId && name !== "preview_status" && name !== "preview_snapshot") throw new Error("The user controls this browser page. Pause browser actions until they return to the chat, then take a fresh snapshot.");
      let cancelled = false;
      const closeActive = () => {
        const thread = this.threads.get(threadId);
        const selected = (parsed.data as { tabId?: string }).tabId ?? thread?.current;
        if (selected) void thread?.tabs.get(selected)?.page.close().catch(() => {});
      };
      const cancel = () => { cancelled = true; closeActive(); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await this.run(threadId, name as BrowserToolName, parsed.data as Record<string, any>, () => cancelled, !!viewerId);
        if (viewerId && !cancelled && ["preview_open", "preview_navigate", "preview_act"].includes(name)) {
          const current = this.threads.get(threadId)?.current;
          if (current) await this.run(threadId, "preview_snapshot", { tabId: current }, () => cancelled);
        }
        if (cancelled) { closeActive(); throw aborted(); }
        return result;
      } finally { signal?.removeEventListener("abort", cancel); if (cancelled) closeActive(); }
    } catch (error) { return errorResult(signal?.aborted ? aborted() : error); }
    finally { release(); }
  }

  private async run(id: string, name: BrowserToolName, input: Record<string, any>, cancelled: () => boolean, viewer = false): Promise<BrowserResult> {
    if (name === "preview_status") return textResult(this.status(id));
    let thread = this.threads.get(id);
    if (name === "preview_open") {
      if (input.url) httpUrl(input.url, thread?.current ? thread.tabs.get(thread.current)?.page.url() : undefined);
      thread ??= await this.thread(id);
      if (cancelled()) throw aborted();
      let selected = input.tabId ?? (input.reuseExistingTab !== false ? thread.current : undefined);
      if (selected && !thread.tabs.has(selected)) throw new Error("Tab not found in this thread.");
      if (!selected) {
        if (thread.tabs.size >= MAX_TABS) throw new Error(`Maximum ${MAX_TABS} tabs per thread.`);
        const page = await thread.context.newPage();
        if (cancelled()) { await page.close(); throw aborted(); }
        selected = crypto.randomUUID();
        const tabId = selected;
        const tab: Tab = { page, refs: new BrowserRefs(), title: "", view: new BrowserView(page, tabId, (frame) => {
          if (this.threads.get(id)?.current !== tabId) return;
          for (const listener of this.viewers.get(id)?.values() ?? []) {
            try { listener(frame); } catch { /* A slow or disconnected viewer cannot break Chromium. */ }
          }
        }) };
        thread.tabs.set(selected, tab);
        page.on("popup", (popup) => { void popup.close().catch(() => {}); });
        page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
        page.on("framenavigated", (frame) => {
          void this.clearRefs(tab);
          if (frame !== page.mainFrame()) return;
          tab.image = undefined;
          if (/^(file|data|blob):/i.test(frame.url())) void page.close().catch(() => {});
          this.emit(id);
        });
        page.on("close", () => { thread!.tabs.delete(tabId); if (thread!.current === tabId) thread!.current = thread!.tabs.keys().next().value; this.emit(id); });
      }
      thread.current = selected;
      const viewport = this.viewports.get(id);
      const selectedTab = thread.tabs.get(selected)!;
      if (viewport && JSON.stringify(selectedTab.page.viewportSize()) !== JSON.stringify(viewport)) {
        selectedTab.refs.clear();
        selectedTab.image = undefined;
        await selectedTab.page.setViewportSize(viewport);
      }
      if (input.url) await this.navigate(thread.tabs.get(selected)!, input.url);
      this.emit(id);
      return textResult(this.status(id));
    }
    if (!thread) throw new Error("No browser tab for this thread. Use preview_open first.");
    const selected = input.tabId ?? thread.current;
    const tab = selected ? thread.tabs.get(selected) : undefined;
    if (!tab || tab.page.isClosed()) throw new Error("Tab not found in this thread.");
    if (!(name === "preview_snapshot" && thread.human) && thread.current !== selected) {
      thread.current = selected;
      this.emit(id);
    }
    const page = tab.page;
    if (name === "preview_close") { await page.close(); this.emit(id); return textResult(this.status(id)); }
    if (name === "preview_navigate") { await this.navigate(tab, input.url, input.timeoutMs); this.emit(id); return textResult(this.status(id)); }
    if (name === "preview_snapshot") {
      const snapshot = await tab.refs.snapshot(page);
      tab.title = (await page.title().catch(() => "")).slice(0, 500);
      let image = await tab.view.capture(viewer ? 3840 : 1280, viewer ? 2160 : 800);
      const limit = viewer ? 8 * 1024 * 1024 : MAX_IMAGE;
      if (image.length > limit && viewer) image = await tab.view.capture();
      tab.image = image.length <= limit ? image.toString("base64") : undefined;
      this.emit(id);
      const result = textResult({ tabId: selected, url: page.url(), title: tab.title, ...snapshot, screenshotAvailable: !!tab.image });
      if (input.includeImage && tab.image) result.content.push({ type: "image", data: tab.image, mimeType: "image/png" });
      return result;
    }
    if (name === "preview_evaluate") {
      // Interrupt a hung script without deleting the thread's other tabs.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void page.close().catch(() => {}); }, input.timeoutMs ?? 15000);
      try {
        const value = await page.evaluate((expression) => (0, eval)(expression), input.expression);
        const json = JSON.stringify({ value: value ?? null });
        if (json.length > 64000) throw new Error("Evaluation result exceeds 64 KB.");
        return textResult(json);
      } catch (error) { if (timedOut) throw new Error("Evaluation timed out; its tab was closed. Other tabs are still available."); throw error; }
      finally { clearTimeout(timer); }
    }
    if (name === "preview_act") {
      const element = input.locator ? tab.refs.locator(page, input.locator) : undefined;
      const options = { timeout: input.timeoutMs ?? 15000 };
      switch (input.action) {
        case "click": if (!element) throw new Error("click requires locator."); await element.click(options); break;
        case "hover": if (!element) throw new Error("hover requires locator."); await element.hover(options); break;
        case "check": if (!element) throw new Error("check requires locator."); await element.check(options); break;
        case "uncheck": if (!element) throw new Error("uncheck requires locator."); await element.uncheck(options); break;
        case "type": if (!element || input.text === undefined) throw new Error("type requires locator and text."); if (input.clear) await element.fill(input.text, options); else { await element.focus(); await page.keyboard.insertText(input.text); } break;
        case "select": if (!element || !input.values) throw new Error("select requires locator and values."); await element.selectOption(input.values, options); break;
        case "press": if (!input.key) throw new Error("press requires key."); if (element) await element.press(input.key, options); else await page.keyboard.press(input.key); break;
        case "scroll": if (element) await element.evaluate((el, delta) => (el as Element).scrollBy(delta.x, delta.y), { x: input.deltaX ?? 0, y: input.deltaY ?? 600 }); else await page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 600); break;
        case "reload": await this.clearRefs(tab); await page.reload({ ...options, waitUntil: "domcontentloaded" }); break;
        case "back": await this.clearRefs(tab); await page.goBack({ ...options, waitUntil: "domcontentloaded" }); break;
        case "forward": await this.clearRefs(tab); await page.goForward({ ...options, waitUntil: "domcontentloaded" }); break;
      }
      tab.image = undefined;
      tab.title = (await page.title().catch(() => "")).slice(0, 500);
      this.emit(id);
      return textResult({ tabId: selected, url: page.url(), action: input.action });
    }
    throw new Error("Unknown browser operation.");
  }

  private async navigate(tab: Tab, url: string, timeout = 15000) {
    const resolved = httpUrl(url, /^https?:/i.test(tab.page.url()) ? tab.page.url() : undefined);
    await this.clearRefs(tab);
    tab.image = undefined;
    const committed = tab.page.waitForEvent("framenavigated", { predicate: (frame) => frame === tab.page.mainFrame(), timeout: timeout + 1000 }).catch(() => {});
    try { await tab.page.goto(resolved, { waitUntil: "domcontentloaded", timeout }); }
    catch (error) {
      await tab.view.stopLoading();
      // Chromium commits its internal error page asynchronously. Drain that navigation
      // before allowing the next address, otherwise a retry is interrupted by the old error.
      await committed;
      throw error;
    }
    tab.title = (await tab.page.title().catch(() => "")).slice(0, 500);
  }
}
