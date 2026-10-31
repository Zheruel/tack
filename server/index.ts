// Tack sidecar: a local WebSocket server the UI talks to.
//   TACK_PORT      port to bind (default: random)
//   TACK_DATA_DIR  where the database and transcripts live
//   TACK_DEV=1     no auth token (for running the UI in a plain browser)

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { projectIcon } from "./favicon";
import { Git } from "./git";
import { Hub } from "./hub";
import { Store } from "./store";
import { Updates } from "./updates";
import { Surfaces } from "./surfaces";
import { chromiumInstalled, installChromium } from "./chromium";
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

let PATH = await loginPath();
// Models often write `python` (a script run, a heredoc). macOS only ships `python3`, so give agents a
// `python` alias rather than let the first call fail.
if (!Bun.which("python", { PATH })) {
  const python3 = Bun.which("python3", { PATH });
  if (python3) {
    const shims = join(dataDir, "shims");
    mkdirSync(shims, { recursive: true });
    rmSync(join(shims, "python"), { force: true });
    symlinkSync(python3, join(shims, "python"));
    PATH = `${shims}:${PATH}`;
  }
}
const bins = {
  claude: Bun.which("claude", { PATH }) ?? undefined,
  codex: Bun.which("codex", { PATH }) ?? undefined,
};
const vars: Record<string, string> = { ...(process.env as Record<string, string>), PATH };
delete vars.TACK_DEV;
delete vars.TACK_PORT;
// Started from inside Claude Code (e.g. its desktop terminal)? Its session variables would make our
// agents load that host's tools and context, so drop them.
if (vars.CLAUDECODE) {
  for (const k of Object.keys(vars)) {
    if (/^(CLAUDE|MCP_|ENABLE_|DISABLE_)/.test(k) || k === "ANTHROPIC_BASE_URL") delete vars[k];
  }
}

const store = new Store(dataDir);
vars.TACK_DATA_DIR = dataDir;
type SocketState = { viewerId: string; browserThread?: string; unwatch?: () => void };
type Socket = ServerWebSocket<SocketState>;
const sockets = new Set<Socket>();
const broadcast = (event: Event) => {
  const frame = JSON.stringify({ event } satisfies ServerFrame);
  for (const ws of sockets) ws.send(frame);
};

const git = new Git(vars);
const surfaces = new Surfaces(join(dataDir, "visuals"),
  (threadId, preview) => broadcast({ type: "browser", threadId, preview }),
  (threadId, status) => broadcast({ type: "desktop", threadId, status }),
  (threadId, preview) => broadcast({ type: "device", threadId, preview }), vars);
const hub = new Hub(store, broadcast, { bins, vars }, git, surfaces);
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

const workspacePath = (projectId: string, threadId?: string) => {
  const path = projectPath(projectId);
  if (!threadId) return path;
  const thread = hub.thread(threadId);
  if (thread.projectId !== projectId) throw new Error("Thread does not belong to this project.");
  return thread.workspace?.path ?? path;
};

type Handlers = { [M in keyof Requests]: (p: Requests[M]["params"], ws: Socket) => Promise<Requests[M]["result"]> | Requests[M]["result"] };

const handlers: Handlers = {
  "device.get": ({ threadId }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    return surfaces.devices.getPreview(threadId);
  },
  "device.command": async ({ threadId, name, input }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    if (!["device_list", "device_open", "device_snapshot", "device_act", "device_close"].includes(name)) throw new Error("Unsupported device command");
    const result = await surfaces.devices.execute(threadId, name, input);
    if (result.isError) throw new Error(result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
    return surfaces.devices.getPreview(threadId);
  },
  "desktop.get": ({ threadId }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    return surfaces.desktop.status(threadId);
  },
  "desktop.revoke": async ({ threadId }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    await surfaces.desktop.finishTurn(threadId, true);
    return surfaces.desktop.status(threadId);
  },
  "browser.get": ({ threadId }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    return { ...surfaces.browser.getPreview(threadId), needsInstall: !chromiumInstalled() };
  },
  "browser.watch": ({ threadId, visible }, ws) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    ws.data.unwatch?.();
    ws.data.unwatch = undefined;
    ws.data.browserThread = undefined;
    if (visible) {
      ws.data.browserThread = threadId;
      ws.data.unwatch = surfaces.browser.watch(threadId, ws.data.viewerId, (frame) => {
        // Drop a stale frame rather than queue megabytes ahead of input and chat replies.
        if (ws.readyState !== 1 || ws.getBufferedAmount() > 2 * 1024 * 1024) return;
        ws.send(JSON.stringify({ event: { type: "browser.frame", threadId, frame } } satisfies ServerFrame));
      });
    }
    return { ...surfaces.browser.getPreview(threadId), needsInstall: !chromiumInstalled() };
  },
  "browser.resize": async ({ threadId, width, height }, ws) => {
    if (!store.thread(threadId) || ws.data.browserThread !== threadId) throw new Error("Open this thread's browser first.");
    await surfaces.browser.resize(threadId, width, height);
    return null;
  },
  "browser.input": async ({ threadId, tabId, input }, ws) => {
    if (!store.thread(threadId) || ws.data.browserThread !== threadId) throw new Error("Open this thread's browser first.");
    return surfaces.browser.input(threadId, tabId, ws.data.viewerId, input);
  },
  "browser.install": async ({ threadId }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    await installChromium();
    return null;
  },
  "browser.command": async ({ threadId, name, input }, ws) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    if (!["preview_open", "preview_navigate", "preview_snapshot", "preview_close", "preview_act"].includes(name)) throw new Error("Unsupported browser command");
    if (name === "preview_act" && !["reload", "back", "forward"].includes(input.action ?? "")) throw new Error("Unsupported browser navigation");
    const result = await surfaces.browser.execute(threadId, name, input, undefined, ws.data.viewerId);
    if (result.isError) throw new Error(result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
    return surfaces.browser.getPreview(threadId);
  },
  "visual.get": ({ threadId, id }) => {
    if (!store.thread(threadId)) throw new Error("Thread not found");
    return surfaces.visual.read(threadId, id);
  },
  "state.get": () => ({
    projects: store.projects(),
    threads: hub.threads(),
    models: hub.models,
    clis: Object.values(updates.status),
    limits: hub.limits,
    approvals: hub.pendingApprovals(),
  }),
  "project.add": ({ path }) => {
    if (!existsSync(path)) throw new Error(`No such folder: ${path}`);
    const project = store.addProject(path.replace(/\/+$/, ""));
    broadcast({ type: "project.upserted", project });
    return project;
  },
  "project.remove": ({ projectId }) => {
    for (const { id: threadId } of store.threads().filter((t) => t.projectId === projectId)) {
      hub.closeThread(threadId);
      broadcast({ type: "thread.removed", threadId });
    }
    store.removeProject(projectId);
    broadcast({ type: "project.removed", projectId });
    return null;
  },
  "thread.create": ({ projectId }) => {
    const { provider, model, effort } = hub.defaultModel();
    const thread = store.createThread(projectId, provider, model, effort);
    broadcast({ type: "thread.upserted", thread });
    return thread;
  },
  "thread.regenerateTitle": ({ threadId }) => (hub.regenerateTitle(threadId), null),
  "thread.rename": ({ threadId, title }) => {
    hub.cancelTitle(threadId); // a title the user chose is not overwritten
    store.updateThread(threadId, { title: title.trim() || "Untitled" });
    broadcast({ type: "thread.upserted", thread: hub.thread(threadId) });
    return null;
  },
  "thread.delete": ({ threadId }) => {
    // A thread's sub-agents go with it.
    const ids = new Set([threadId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const thread of store.threads()) if (thread.parentId && ids.has(thread.parentId) && !ids.has(thread.id)) {
        ids.add(thread.id);
        changed = true;
      }
    }
    for (const id of [...ids].reverse()) {
      hub.closeThread(id);
      store.deleteThread(id);
      broadcast({ type: "thread.removed", threadId: id });
    }
    return null;
  },
  "thread.open": ({ threadId }) => hub.open(threadId),
  "thread.settle": ({ threadId, settled }) => (hub.settle(threadId, settled), null),
  "thread.configure": ({ threadId, ...patch }) => hub.configure(threadId, patch),
  "chat.send": ({ threadId, text, attachments, steer }) => {
    // A sub-agent takes its direction from the agent that started it (agent_send), not from the user.
    if (store.thread(threadId)?.parentId) throw new Error("Message the thread that started this agent instead.");
    hub.send(threadId, text, attachments, steer);
    return null;
  },
  "chat.unqueue": ({ threadId, queuedId }) => (hub.unqueue(threadId, queuedId), null),
  "chat.edit": ({ threadId, queuedId, text }) => (hub.edit(threadId, queuedId, text), null),
  "chat.resume": ({ threadId }) => (hub.resume(threadId), null),
  "chat.steer": ({ threadId, queuedId }) => (hub.steer(threadId, queuedId), null),
  "chat.interrupt": async ({ threadId }) => (await hub.interrupt(threadId), null),
  "agent.answer": async ({ threadId, text }) => (await hub.answerAgent(threadId, text), null),
  "approval.answer": ({ approvalId, allow }) => (hub.answer(approvalId, allow), null),
  "commands.list": ({ projectId, provider }) => hub.commands(projectId, provider),
  "files.search": ({ projectId, query }) => git.search(projectPath(projectId), query),
  "project.icon": ({ projectId }) => projectIcon(projectPath(projectId)),
  "threads.search": ({ query }) => store.searchThreads(query),
  "git.info": ({ projectId, threadId }) => git.info(workspacePath(projectId, threadId)),
  "git.branches": ({ projectId }) => git.branches(projectPath(projectId)),
  "git.checkout": async ({ projectId, branch }) => (await git.checkout(projectPath(projectId), branch), null),
  "git.prs": ({ threadId }) => {
    const top = hub.rootThread(threadId);
    return git.prs(projectPath(top.projectId), top.prs ?? []);
  },
  "cli.update": ({ name }) => (updates.update(name), null),
  "project.reveal": ({ projectId, threadId }) => (Bun.spawn(["open", "-R", workspacePath(projectId, threadId)]), null),
};

const server = Bun.serve<SocketState>({
  hostname: "127.0.0.1",
  port: Number(process.env.TACK_PORT ?? 0),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return new Response("tack", { status: 404 });
    if (!dev && url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
    return server.upgrade(req, { data: { viewerId: crypto.randomUUID() } }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    perMessageDeflate: false,
    open: (ws) => void sockets.add(ws),
    close: (ws) => { ws.data.unwatch?.(); sockets.delete(ws); },
    async message(ws, raw) {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        const handler = handlers[frame.method] as (p: unknown, ws: Socket) => unknown;
        if (!handler) throw new Error(`Unknown method: ${frame.method}`);
        const result = await handler(frame.params, ws);
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

hub.backfillBranches().catch(() => {});
hub.recoverAgents();
hub.loadModels().catch((e) => console.error("tack: could not load models:", e.message));

// Exit with the parent (Tauri closes our stdin when it quits).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Device cleanup can need a bounded daemon retirement and simulator shutdown.
  const timeout = setTimeout(() => process.exit(0), 20_000).unref();
  await Promise.allSettled([hub.shutdown(), surfaces.dispose()]);
  clearTimeout(timeout);
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
if (!dev) {
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}
