import { z } from "zod";
import type { CDPSession, Page } from "playwright";
import type { BrowserFrame, BrowserInput } from "../shared/protocol";

const coordinate = z.number().min(0).max(1);
const modifiers = z.number().int().min(0).max(15).optional();
export const browserInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("focus") }),
  z.object({ type: z.literal("release") }),
  z.object({ type: z.literal("mouse"), action: z.enum(["move", "down", "up"]), x: coordinate, y: coordinate, button: z.enum(["none", "left", "middle", "right"]).optional(), buttons: z.number().int().min(0).max(7).optional(), clickCount: z.number().int().min(0).max(2).optional(), modifiers }),
  z.object({ type: z.literal("wheel"), x: coordinate, y: coordinate, deltaX: z.number().min(-10000).max(10000), deltaY: z.number().min(-10000).max(10000), modifiers }),
  z.object({ type: z.literal("key"), action: z.enum(["down", "up"]), key: z.string().min(1).max(100), code: z.string().max(100), keyCode: z.number().int().min(0).max(255), modifiers: z.number().int().min(0).max(15), text: z.string().max(100).optional() }),
  z.object({ type: z.literal("text"), text: z.string().max(20000) }),
]);

// A bounded, shared Chromium view, following T3's CDP screencast/input approach.
// Frames go only to visible viewers; every frame is acknowledged even when dropped.
export class BrowserView {
  private session?: Promise<CDPSession>;
  private streaming = false;
  private lastFrameAt = 0;
  private pendingFrame?: BrowserFrame;
  private flush?: ReturnType<typeof setTimeout>;
  private keys = new Map<string, { key: string; code: string }>();
  private buttons = new Map<"left" | "middle" | "right", { x: number; y: number }>();

  constructor(private page: Page, private tabId: string, private frame: (frame: BrowserFrame) => void) {
    page.on("close", () => { this.streaming = false; clearTimeout(this.flush); this.pendingFrame = undefined; });
  }

  private cdp(): Promise<CDPSession> {
    return this.session ??= this.page.context().newCDPSession(this.page).then((session) => {
      session.on("Page.screencastFrame", (event) => {
        void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        if (!this.streaming || event.data.length > 6 * 1024 * 1024) return;
        const size = { width: event.metadata.deviceWidth, height: event.metadata.deviceHeight };
        this.pendingFrame = { tabId: this.tabId, image: event.data, mimeType: "image/jpeg", ...size };
        if (!this.flush) this.flush = setTimeout(() => this.emitFrame(), Math.max(0, 80 - (Date.now() - this.lastFrameAt)));
      });
      return session;
    }).catch((error) => { this.session = undefined; throw error; });
  }

  private emitFrame() {
    this.flush = undefined;
    const frame = this.pendingFrame;
    this.pendingFrame = undefined;
    if (frame && this.streaming) { this.lastFrameAt = Date.now(); this.frame(frame); }
  }

  async start() {
    if (this.streaming || this.page.isClosed()) return;
    const session = await this.cdp();
    this.streaming = true;
    try {
      await session.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
    } catch (error) { this.streaming = false; throw error; }
  }

  async stop() {
    if (!this.streaming) return;
    this.streaming = false;
    clearTimeout(this.flush);
    this.flush = undefined;
    this.pendingFrame = undefined;
    await this.session?.then((session) => session.send("Page.stopScreencast")).catch(() => {});
  }

  private async copiedText(): Promise<string> {
    let frame = this.page.mainFrame();
    while (true) {
      const active = await frame.evaluateHandle(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        return element;
      });
      let nested;
      try { nested = await active.asElement()?.contentFrame(); }
      finally { await active.dispose(); }
      if (!nested) break;
      frame = nested;
    }
    return frame.evaluate(() => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0)
        : window.getSelection()?.toString() ?? "";
    });
  }

  async input(input: BrowserInput): Promise<{ clipboard?: string }> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void this.page.close().catch(() => {}); }, 10000);
    try { return await this.deliverInput(input); }
    catch (error) { if (timedOut) throw new Error("Browser input timed out; its tab was closed. Other tabs are still available."); throw error; }
    finally { clearTimeout(timer); }
  }

  private async deliverInput(input: BrowserInput): Promise<{ clipboard?: string }> {
    const session = await this.cdp();
    const size = this.page.viewportSize() ?? { width: 1280, height: 800 };
    if (input.type === "mouse" || input.type === "wheel") {
      const x = Math.min(size.width - 1, input.x * size.width);
      const y = Math.min(size.height - 1, input.y * size.height);
      if (input.type === "wheel") {
        await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers ?? 0 });
      } else {
        const button = input.button ?? "none";
        await session.send("Input.dispatchMouseEvent", { type: input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved", x, y, button, buttons: input.buttons ?? 0, clickCount: input.clickCount ?? (input.action === "move" ? 0 : 1), modifiers: input.modifiers ?? 0 });
        if (button !== "none") {
          if (input.action === "down") this.buttons.set(button, { x, y });
          if (input.action === "up") this.buttons.delete(button);
        }
      }
    } else if (input.type === "key") {
      const shortcut = input.action === "down" && (input.modifiers & 6) && !((input.modifiers & 1)) ? input.key.toLowerCase() : "";
      const command = ({ a: "selectAll", c: "copy", x: "cut", z: input.modifiers & 8 ? "redo" : "undo", y: "redo" } as Record<string, string>)[shortcut];
      let clipboard: string | undefined;
      if (shortcut === "c" || shortcut === "x") clipboard = await this.copiedText();
      await session.send("Input.dispatchKeyEvent", { type: input.action === "up" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown", key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, modifiers: input.modifiers, ...(input.text ? { text: input.text, unmodifiedText: input.text } : {}), ...(command ? { commands: [command] } : {}) });
      if (input.action === "down") this.keys.set(input.code || input.key, { key: input.key, code: input.code });
      else this.keys.delete(input.code || input.key);
      if (clipboard !== undefined) return { clipboard };
    } else if (input.type === "text") {
      await session.send("Input.insertText", { text: input.text });
    }
    return {};
  }

  async release() {
    const keys = [...this.keys.values()];
    const buttons = [...this.buttons];
    this.keys.clear(); this.buttons.clear();
    if (!keys.length && !buttons.length) return;
    const session = await this.cdp().catch(() => undefined);
    if (!session) return;
    for (const key of keys) await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers: 0 }).catch(() => {});
    for (const [button, position] of buttons) await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, ...position, buttons: 0, clickCount: 1 }).catch(() => {});
  }

  async stopLoading() { await (await this.cdp()).send("Page.stopLoading").catch(() => {}); }

  async capture(maxWidth = 1280, maxHeight = 800): Promise<Buffer> {
    const size = this.page.viewportSize() ?? { width: 1280, height: 800 };
    const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
    if (scale === 1) return this.page.screenshot({ type: "png", timeout: 10000 });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void this.page.close().catch(() => {}); }, 10000);
    try {
      const session = await this.cdp();
      const metrics = await session.send("Page.getLayoutMetrics");
      const { data } = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: metrics.cssVisualViewport.pageX, y: metrics.cssVisualViewport.pageY, ...size, scale } });
      return Buffer.from(data, "base64");
    } catch (error) { if (timedOut) throw new Error("Browser capture timed out; its tab was closed."); throw error; }
    finally { clearTimeout(timer); }
  }
}
