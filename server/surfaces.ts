import { z } from "zod";
import { BROWSER_TOOLS, BrowserService } from "./browser";
import { TOOLS } from "./prompt";
import type { ToolResult } from "./session";
import { VisualService } from "./visual";
import { VISUALIZE_GUIDE } from "./visualize";
import { chromiumInstalled, installChromium } from "./chromium";
import type { BrowserPreview } from "../shared/protocol";

export const SURFACE_TOOLS = { show: TOOLS.show, show_preview: TOOLS.show_preview, visualize: TOOLS.visualize, ...BROWSER_TOOLS };
export type SurfaceTool = keyof typeof SURFACE_TOOLS;
export const isSurfaceTool = (name: string): name is SurfaceTool => Object.hasOwn(SURFACE_TOOLS, name);

export class Surfaces {
  readonly browser: BrowserService;
  readonly visual: VisualService;

  constructor(directory: string, onBrowser?: (threadId: string, preview: BrowserPreview) => void) {
    this.browser = new BrowserService(onBrowser);
    this.visual = new VisualService(directory);
  }

  async execute(threadId: string, name: string, input: unknown, signal?: AbortSignal, approveInstall?: () => Promise<boolean>): Promise<ToolResult> {
    try {
      if (!isSurfaceTool(name)) throw new Error(`Unknown surface tool: ${name}`);
      const parsed = z.object(SURFACE_TOOLS[name].input).parse(input);
      if ((name === "show_preview" || name === "preview_open") && !chromiumInstalled() && approveInstall) {
        signal?.throwIfAborted();
        if (!await approveInstall()) throw new Error("Isolated browser setup was declined. No desktop or personal browser was opened.");
        signal?.throwIfAborted();
        await installChromium();
        signal?.throwIfAborted();
      }
      if (name === "show") return await this.visual.publish(threadId, parsed, signal);
      if (name === "show_preview") return await this.visual.preview(parsed, signal);
      if (name === "visualize") return { content: [{ type: "text", text: VISUALIZE_GUIDE }] };
      return await this.browser.execute(threadId, name, parsed, signal);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }

  async dispose() {
    await Promise.allSettled([this.browser.dispose(), this.visual.dispose()]);
  }
}
