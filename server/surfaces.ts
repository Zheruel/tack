import { z } from "zod";
import { dirname } from "node:path";
import { BROWSER_TOOLS, BrowserService } from "./browser";
import { TOOLS } from "./prompt";
import type { SessionEvents, ToolResult } from "./session";
import { DESKTOP_TOOLS, DesktopService } from "./desktop";
import { VisualService } from "./visual";
import { VISUALIZE_GUIDE } from "./visualize";
import { chromiumInstalled, installChromium } from "./chromium";
import { DEVICE_TOOLS, DeviceService } from "./devices";
import type { DevicePreview } from "../shared/devices";
import type { BrowserPreview, DesktopStatus } from "../shared/protocol";

export const SURFACE_TOOLS = { show: TOOLS.show, show_preview: TOOLS.show_preview, visualize: TOOLS.visualize, ...BROWSER_TOOLS, ...DESKTOP_TOOLS, ...DEVICE_TOOLS };
export type SurfaceTool = keyof typeof SURFACE_TOOLS;
export const isSurfaceTool = (name: string): name is SurfaceTool => Object.hasOwn(SURFACE_TOOLS, name);

export class Surfaces {
  readonly browser: BrowserService;
  readonly visual: VisualService;
  readonly desktop: DesktopService;
  readonly devices: DeviceService;

  constructor(directory: string, onBrowser?: (threadId: string, preview: BrowserPreview) => void, onDesktop?: (threadId: string, status: DesktopStatus) => void, onDevice?: (threadId: string, preview: DevicePreview) => void, env?: Record<string, string>) {
    this.browser = new BrowserService(onBrowser);
    this.visual = new VisualService(directory);
    this.desktop = new DesktopService(onDesktop);
    this.devices = new DeviceService(dirname(directory), onDevice, env);
  }

  async execute(threadId: string, name: string, input: unknown, signal?: AbortSignal, approve?: SessionEvents["approve"]): Promise<ToolResult> {
    try {
      if (!isSurfaceTool(name)) throw new Error(`Unknown surface tool: ${name}`);
      const parsed = z.object(SURFACE_TOOLS[name].input).parse(input);
      if (name.startsWith("desktop_")) return await this.desktop.execute(threadId, name, parsed, signal, approve);
      if (name.startsWith("device_")) return await this.devices.execute(threadId, name, parsed, signal);
      if ((name === "show_preview" || name === "preview_open") && !chromiumInstalled() && approve) {
        signal?.throwIfAborted();
        if (!await approve("BrowserInstall", {}, signal ?? new AbortController().signal)) throw new Error("Isolated browser setup was declined. No desktop or personal browser was opened.");
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
    await Promise.allSettled([this.browser.dispose(), this.visual.dispose(), this.desktop.dispose(), this.devices.dispose()]);
  }
}
