// Tack sidecar: a local WebSocket server the UI talks to.
//   TACK_PORT      port to bind (default: random)
//   TACK_DATA_DIR  where the database and transcripts live
//   TACK_DEV=1     no auth token (for running the UI in a plain browser)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Git } from "./git";
import { Hub } from "./hub";
import { Store } from "./store";
import { Updates } from "./updates";
import type { ClientFrame, Event, Requests, ServerFrame } from "../shared/protocol";

const dev = process.env.TACK_DEV === "1";
const dataDir = process.env.TACK_DATA_DIR ?? join(homedir(), "Library", "Application Support", "dev.tack.app");
const token = dev ? "" : crypto.randomUUID();

// Apps launched from Finder get a minimal PATH; use the login shell's so `claude`, git and friends resolve.
async function loginPath(): Promise<string> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const proc = Bun.spawn([shell, "-ilc", 'printf "__PATH__%s" "$PATH"'], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const path = out.split("__PATH__")[1];
    if (path) return path;
  } catch {}
  return process.env.PATH ?? "";
}

const PATH = await loginPath();
const bins = {
  claude: Bun.which("claude", { PATH }) ?? undefined,
  codex: Bun.which("codex", { PATH }) ?? undefined,
};
const vars: Record<string, string> = { ...(process.env as Record<string, string>), PATH };
delete vars.TACK_DEV;
delete vars.TACK_PORT;

const store = new Store(dataDir);
const sockets = new Set<ServerWebSocket<unknown>>();
const broadcast = (event: Event) => {
  const frame = JSON.stringify({ event } satisfies ServerFrame);
  for (const ws of sockets) ws.send(frame);
};
const hub = new Hub(store, broadcast, { bins, vars });
const git = new Git(vars);
const updates = new Updates(
  bins,
  vars,
  (status) => broadcast({ type: "cli", status }),
  (name) => hub.restartProvider(name),
);

const projectPath = (projectId: string) => {
  const project = store.project(projectId);
  if (!project) throw new Error("Project not found");
  return project.path;
};

type Handlers = { [M in keyof Requests]: (p: Requests[M]["params"]) => Promise<Requests[M]["result"]> | Requests[M]["result"] };

const handlers: Handlers = {
  "state.get": () => ({
    projects: store.projects(),
    threads: hub.threads(),
    models: hub.models,
    clis: Object.values(updates.status),
  }),
  "project.add": ({ path }) => {
    if (!existsSync(path)) throw new Error(`No such folder: ${path}`);
    const project = store.addProject(path.replace(/\/+$/, ""));
    broadcast({ type: "project.upserted", project });
    return project;
  },
  "project.remove": ({ projectId }) => {
    for (const threadId of store.removeProject(projectId)) {
      hub.closeThread(threadId);
      broadcast({ type: "thread.removed", threadId });
    }
    broadcast({ type: "project.removed", projectId });
    return null;
  },
  "thread.create": ({ projectId }) => {
    const { provider, model, effort } = hub.defaultModel();
    const thread = store.createThread(projectId, provider, model, effort);
    broadcast({ type: "thread.upserted", thread });
    return thread;
  },
  "thread.rename": ({ threadId, title }) => {
    store.updateThread(threadId, { title: title.trim() || "Untitled" });
    broadcast({ type: "thread.upserted", thread: hub.thread(threadId) });
    return null;
  },
  "thread.delete": ({ threadId }) => {
    hub.closeThread(threadId);
    store.deleteThread(threadId);
    broadcast({ type: "thread.removed", threadId });
    return null;
  },
  "thread.open": ({ threadId }) => hub.open(threadId),
  "thread.settle": ({ threadId, settled }) => (hub.settle(threadId, settled), null),
  "thread.configure": ({ threadId, ...patch }) => hub.configure(threadId, patch),
  "chat.send": ({ threadId, text, attachments, steer }) => {
    hub.send(threadId, text, attachments, steer);
    return null;
  },
  "chat.unqueue": ({ threadId, queuedId }) => (hub.unqueue(threadId, queuedId), null),
  "chat.steer": ({ threadId, queuedId }) => (hub.steer(threadId, queuedId), null),
  "chat.interrupt": async ({ threadId }) => (await hub.interrupt(threadId), null),
  "approval.answer": ({ approvalId, allow }) => (hub.answer(approvalId, allow), null),
  "commands.list": ({ projectId, provider }) => hub.commands(projectId, provider),
  "files.search": ({ projectId, query }) => git.search(projectPath(projectId), query),
  "git.info": ({ projectId }) => git.info(projectPath(projectId)),
  "cli.update": ({ name }) => (updates.update(name), null),
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TACK_PORT ?? 0),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("tack", { status: 404 });
    if (!dev && url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
    return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    perMessageDeflate: false,
    open: (ws) => void sockets.add(ws),
    close: (ws) => void sockets.delete(ws),
    async message(ws, raw) {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        const handler = handlers[frame.method] as (p: unknown) => unknown;
        if (!handler) throw new Error(`Unknown method: ${frame.method}`);
        const result = await handler(frame.params);
        ws.send(JSON.stringify({ id: frame.id, result: result ?? null } satisfies ServerFrame));
      } catch (e) {
        ws.send(JSON.stringify({ id: frame.id, error: e instanceof Error ? e.message : String(e) } satisfies ServerFrame));
      }
    },
  },
});

// The Tauri shell reads this line to learn where to connect.
console.log(`TACK_READY ${JSON.stringify({ port: server.port, token })}`);
if (!bins.claude && !bins.codex) console.error("tack: neither `claude` nor `codex` found on PATH");

hub.loadModels().catch((e) => console.error("tack: could not load models:", e.message));

// Exit with the parent (Tauri closes our stdin when it quits).
if (!dev) {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
