import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as Playwright from "playwright";

// Playwright reads support files at runtime. Ship its unmodified package beside the sidecar
// rather than flattening those files into Bun's single executable.
const runtime = process.env.TACK_RESOURCE_DIR && join(process.env.TACK_RESOURCE_DIR, "browser-runtime", "entry.js");
const load = createRequire(runtime || import.meta.url);
let playwright: typeof Playwright | undefined;

export function isolatedChromium() {
  playwright ??= load("playwright") as typeof Playwright;
  return playwright.chromium;
}

export function chromiumInstalled() {
  return existsSync(isolatedChromium().executablePath());
}

let installing: Promise<void> | undefined;
export function installChromium(): Promise<void> {
  return installing ??= (async () => {
    const cli = join(dirname(load.resolve("playwright/package.json")), "cli.js");
    const process = Bun.spawn([globalThis.process.execPath, cli, "install", "chromium"], {
      env: { ...globalThis.process.env, BUN_BE_BUN: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => process.kill(), 10 * 60_000);
    const stop = () => process.kill();
    globalThis.process.once("exit", stop);
    try {
      const [code, output, errors] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      if (code !== 0) throw new Error((errors || output || "Chromium installation failed").slice(-1200));
    } finally {
      clearTimeout(timer);
      globalThis.process.removeListener("exit", stop);
    }
  })().finally(() => { installing = undefined; });
}
