import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { isolatedChromium } from "./chromium";
import { z } from "zod";
import { visualDocument, VISUAL_MAX_HEIGHT, VISUAL_MAX_HTML, type VisualReference } from "../shared/visual";
import type { ToolResult } from "./session";

export const visualInput = {
  title: z.string().min(1).max(200).describe("A short title for the visual"),
  html: z.string().min(1).max(VISUAL_MAX_HTML).describe("Self-contained HTML with inline CSS/SVG/JS. No external requests. Absolute local img paths are inlined"),
  height: z.number().int().min(80).max(2000).optional().describe("Initial height in CSS px. Content is fitted automatically"),
};

export const visualPreviewInput = {
  html: visualInput.html,
  width: z.number().int().min(240).max(1600).optional().describe("CSS width; default 728. Use 390 to check phone layout"),
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREPARED_BYTES = 20 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;

function imageType(bytes: Uint8Array): string | undefined {
  const start = Buffer.from(bytes.slice(0, 512));
  if (start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (start[0] === 0xff && start[1] === 0xd8 && start[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a/.test(start.toString())) return "image/gif";
  if (start.toString("ascii", 0, 4) === "RIFF" && start.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(start.toString())) return "image/svg+xml";
}

export async function prepareVisual(html: string): Promise<string> {
  // Fitted frames and viewport-height CSS form an ever-growing resize feedback loop.
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>|\bstyle\s*=\s*(["'])([\s\S]*?)\2/gi)].map((m) => m[1] ?? m[3] ?? "");
  if (styles.some((css) => /(?:\d|\.)\s*(?:d|s|l)?vh\b/i.test(css))) throw new Error("Use content height or fixed CSS pixels, not vh/dvh/svh/lvh units. The visual frame fits its content.");
  let prepared = "";
  let cursor = 0;
  for (const match of html.matchAll(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi)) {
    const source = match[3]!.replaceAll("&amp;", "&");
    if (!isAbsolute(source) && !source.startsWith("file://")) continue;
    const path = source.startsWith("file://") ? fileURLToPath(source) : source;
    const file = Bun.file(path);
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`Local image exceeds 5 MiB: ${path}`);
    const bytes = new Uint8Array(await file.arrayBuffer().catch(() => { throw new Error(`Local image could not be read: ${path}`); }));
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Local image exceeds 5 MiB: ${path}`);
    const mimeType = imageType(bytes);
    if (!mimeType) throw new Error(`Not a supported image: ${path}. Use PNG, JPEG, GIF, WebP or SVG.`);
    prepared += html.slice(cursor, match.index) + `${match[1]}${match[2]}data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}${match[2]}`;
    cursor = match.index! + match[0].length;
    if (Buffer.byteLength(prepared) > MAX_PREPARED_BYTES) throw new Error("The visual and its images must fit within 20 MiB.");
  }
  prepared += html.slice(cursor);
  if (Buffer.byteLength(prepared) > MAX_PREPARED_BYTES) throw new Error("The visual and its images must fit within 20 MiB.");
  return prepared;
}

export class VisualService {
  private browser?: Promise<Browser>;
  private idle?: Timer;
  private active = 0;

  constructor(private directory: string) {}

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const pending = isolatedChromium().launch({ headless: true, chromiumSandbox: true }).catch((error) => {
        if (this.browser === pending) this.browser = undefined;
        throw new Error(`Visual preview could not launch isolated Chromium. Install it with bunx playwright install chromium. ${String(error).split("\n")[0]}`);
      });
      this.browser = pending;
      void pending.then((browser) => browser.on("disconnected", () => {
        if (this.browser === pending) this.browser = undefined;
      }), () => {});
    }
    return this.browser;
  }

  private path(threadId: string, id: string) {
    if (!idPattern.test(threadId) || !idPattern.test(id)) throw new Error("Invalid visual reference");
    return join(this.directory, threadId, `${id}.html`);
  }

  async read(threadId: string, id: string) {
    return readFile(this.path(threadId, id), "utf8");
  }

  async publish(threadId: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const data = z.object(visualInput).parse(input);
    const html = await prepareVisual(data.html);
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const path = this.path(threadId, id);
    await mkdir(join(this.directory, threadId), { recursive: true });
    await writeFile(path, html, { mode: 0o600 });
    const visual: VisualReference = { id, title: data.title.trim(), height: data.height };
    return { content: [{ type: "text", text: JSON.stringify({ visual, message: "Shown inline with an expanded view. Do not repeat the visual's content." }) }] };
  }

  async preview(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (this.active >= 2) throw new Error("Two visual previews are already running. Wait for one to finish.");
    this.active++;
    clearTimeout(this.idle);
    let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
    const abort = () => { void context?.close().catch(() => {}); };
    try {
      const { html, width = 728 } = z.object(visualPreviewInput).parse(input);
      const prepared = await prepareVisual(html);
      signal?.throwIfAborted();
      const browser = await this.launch();
      context = await browser.newContext({ viewport: { width, height: 200 }, deviceScaleFactor: 1, colorScheme: "dark", serviceWorkers: "block", acceptDownloads: false });
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      const messages: { level: string; text: string }[] = [];
      const add = (level: string, text: string) => { if (messages.length < 30) messages.push({ level, text: text.slice(0, 700) }); };
      page.on("console", (message) => add(message.type(), message.text()));
      page.on("pageerror", (error) => add("error", error.message));
      page.on("popup", (popup) => { void popup.close(); });
      await page.setContent(visualDocument(prepared, "preview"), { waitUntil: "load", timeout: 12_000 });
      await page.evaluate(() => document.fonts.ready);
      const measured = await page.evaluate(() => ({
        height: Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight)),
        overflow: document.body.scrollWidth > innerWidth + 1,
        missingImages: Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")?.slice(0, 120) ?? ""),
      }));
      const height = Math.min(VISUAL_MAX_HEIGHT, Math.max(80, measured.height));
      await page.setViewportSize({ width, height: Math.min(2000, height) });
      const screenshot = await page.screenshot({ type: "png", timeout: 10_000, animations: "disabled" });
      signal?.throwIfAborted();
      return { content: [
        { type: "text", text: JSON.stringify({ width, contentHeight: measured.height, capturedHeight: Math.min(2000, height), horizontalOverflow: measured.overflow, consoleMessages: messages, missingImages: measured.missingImages, note: "Screenshot and runtime diagnostics only; interaction correctness is not verified." }) },
        { type: "image", mimeType: "image/png", data: screenshot.toString("base64") },
      ] };
    } finally {
      signal?.removeEventListener("abort", abort);
      await context?.close().catch(() => {});
      this.active--;
      if (!this.active) this.idle = setTimeout(() => { void this.dispose(); }, 60_000).unref();
    }
  }

  async dispose() {
    clearTimeout(this.idle);
    const browser = this.browser;
    this.browser = undefined;
    await browser?.then((browser) => browser.close()).catch(() => {});
  }
}
