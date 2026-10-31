// Cua owns native targeting and input delivery. Tack owns the process, app scope, and lifetime.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "./session";

export type DesktopReply = ToolResult & {
  structuredContent?: Record<string, unknown>;
};
export interface DesktopDriver {
  call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DesktopReply>;
  close(): Promise<void>;
}

export function desktopBinary() {
  return process.env.TACK_RESOURCE_DIR
    ? join(process.env.TACK_RESOURCE_DIR, "cua-driver", "cua-driver")
    : fileURLToPath(
        new URL(
          "../src-tauri/resources/cua-driver/cua-driver",
          import.meta.url,
        ),
      );
}

export function desktopAvailable() {
  return process.platform === "darwin" && existsSync(desktopBinary());
}

const INPUT_TOOLS = [
  "launch_app",
  "bring_to_front",
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
  "set_value",
];

export async function startDesktopDriver(
  apps: string[],
  signal?: AbortSignal,
): Promise<DesktopDriver> {
  signal?.throwIfAborted();
  if (!desktopAvailable())
    throw new Error(
      "Computer use is unavailable. Run bun run build:server to prepare Tack's Cua runtime.",
    );
  // Short, private paths also stay within macOS's Unix-socket path limit.
  const directory = mkdtempSync(join(tmpdir(), "tack-cu-"));
  const socket = join(directory, "driver.sock");
  const manifest = join(directory, "scope.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 3,
      expires_after: "8h",
      idle_timeout: "30m",
      allow: {
        tools: [
          "check_permissions",
          "list_apps",
          ...(apps.length ? INPUT_TOOLS : []),
        ],
      },
      // Discovery can enumerate app metadata, but its tool ceiling cannot capture or send input.
      resources: {
        apps: apps.map((bundle_id) => ({
          bundle_id,
          launch: true,
          windows: "all",
        })),
        desktop: { display: apps.length === 0 },
      },
    }),
    { mode: 0o600 },
  );
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    DO_NOT_TRACK: "1",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    CUA_TELEMETRY_ENABLED: "0",
    CUA_DRIVER_RS_UPDATE_CHECK: "0",
    CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
  };
  const binary = desktopBinary();
  const daemon = (() => {
    try {
      return Bun.spawn(
        [
          binary,
          "serve",
          "--embedded",
          "--parent-liveness-stdio",
          "--no-permissions-gate",
          "--socket",
          socket,
          "--pid-file",
          join(directory, "driver.pid"),
          "--host-bundle-id",
          "dev.tack.app",
          "--permission-mode",
          "bounded",
          "--capability-manifest",
          manifest,
          "--approve-capability-manifest",
        ],
        { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  })();
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of daemon.stderr)
      stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-2000);
  })().catch(() => {});
  const client = new Client({ name: "tack", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: binary,
    args: [
      "mcp",
      "--embedded",
      "--socket",
      socket,
      "--host-bundle-id",
      "dev.tack.app",
    ],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  let closing: Promise<void> | undefined;
  const kill = () => {
    try {
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    } catch {}
  };
  const close = () =>
    (closing ??= (async () => {
      // Killing the executor, not only its proxy, prevents timed-out input from continuing behind a new call.
      kill();
      await Promise.allSettled([daemon.exited, client.close()]);
      process.removeListener("exit", kill);
      rmSync(directory, { recursive: true, force: true });
    })());
  process.once("exit", kill);
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(socket)) {
      signal?.throwIfAborted();
      if (daemon.exitCode !== null)
        throw new Error(stderr.trim() || "Cua exited before startup.");
      if (Date.now() > deadline) throw new Error("Cua did not start in time.");
      await Bun.sleep(25);
    }
    await client.connect(transport, { signal, timeout: 10_000 });
    return {
      async call(name, input, signal) {
        signal?.throwIfAborted();
        if (closing)
          throw new Error(
            "Desktop session closed. Take a fresh snapshot before acting.",
          );
        if (INPUT_TOOLS.includes(name) && input.delivery_mode === "foreground")
          throw new Error(
            "System mouse delivery is disabled. Activate the app and use the agent cursor instead.",
          );
        const cancel = () => {
          void close();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return (await client.callTool({ name, arguments: input }, undefined, {
            signal,
            timeout: 120_000,
          })) as DesktopReply;
        } catch (error) {
          await close();
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}. Desktop execution stopped; an action may have partially executed. Observe again before retrying.`,
          );
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function desktopData(reply: DesktopReply): Record<string, any> {
  if (reply.isError)
    throw new Error(
      reply.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n") || "Cua refused the operation.",
    );
  if (reply.structuredContent) return reply.structuredContent;
  try {
    return JSON.parse(
      reply.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
    );
  } catch {
    throw new Error("Cua returned an unreadable result. No input was sent.");
  }
}
