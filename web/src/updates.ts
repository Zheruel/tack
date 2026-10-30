// Updates for everything Tack depends on: the app itself (Tauri updater, signed GitHub releases)
// and the agent CLIs (updated by the sidecar). One list, one "Update all".

import type { Update } from "@tauri-apps/plugin-updater";
import type { CliName } from "../../shared/protocol";
import { inTauri } from "./native";
import { call } from "./rpc";
import { useApp } from "./store";

export type UpdateId = "tack" | CliName;

export interface UpdateItem {
  id: UpdateId;
  name: string;
  from?: string;
  to?: string;
  state: "available" | "updating" | "ready" | "done" | "failed";
  percent?: number; // app download progress
  error?: string;
}

const CHECK_EVERY_MS = 3 * 60 * 60_000;
const CLI_NAMES: Record<CliName, string> = { claude: "Claude Code", codex: "Codex" };

let pending: Update | null = null;

// ---- app

export function startAppUpdates() {
  if (!inTauri) return;
  checkApp();
  setInterval(checkApp, CHECK_EVERY_MS);
}

async function checkApp() {
  const current = useApp.getState().appUpdate;
  if (current && current.state !== "failed") return; // already found or in progress
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    pending = update;
    setApp({ id: "tack", name: "Tack", from: update.currentVersion, to: update.version, state: "available" });
  } catch (e) {
    console.warn("tack: update check failed", e); // offline, or no release published yet
  }
}

async function installApp() {
  if (!pending) return;
  const item = useApp.getState().appUpdate!;
  setApp({ ...item, state: "updating", percent: 0, error: undefined });
  let total = 0;
  let done = 0;
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        done += e.data.chunkLength;
        if (total) setApp({ ...item, state: "updating", percent: Math.round((done / total) * 100) });
      }
    });
    setApp({ ...item, state: "ready", percent: undefined });
  } catch (e) {
    setApp({ ...item, state: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}

function setApp(appUpdate: UpdateItem) {
  useApp.setState({ appUpdate });
}

// Restart once no agent is mid-reply, so nothing gets cut off.
export function restartWhenIdle() {
  useApp.setState({ restartPending: true });
  const tryRestart = async () => {
    const running = Object.values(useApp.getState().threads).some((t) => t.status === "running");
    if (running) return false;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return true;
  };
  tryRestart().then((ok) => {
    if (ok) return;
    const off = useApp.subscribe(async () => {
      if (await tryRestart()) off();
    });
  });
}

// ---- everything

export function useUpdates(): UpdateItem[] {
  const app = useApp((s) => s.appUpdate);
  const clis = useApp((s) => s.clis);
  const done = useApp((s) => s.updatedClis);
  const items: UpdateItem[] = app ? [app] : [];
  for (const c of Object.values(clis)) {
    const base = { id: c.name, name: CLI_NAMES[c.name], from: c.installed, to: c.latest };
    if (c.state === "updating") items.push({ ...base, state: "updating" });
    else if (c.state === "available") items.push({ ...base, state: c.error ? "failed" : "available", error: c.error });
    else if (done[c.name]) items.push({ ...base, from: done[c.name], state: "done" });
  }
  return items;
}

export function update(item: UpdateItem) {
  if (item.id === "tack") return installApp();
  return call("cli.update", { name: item.id });
}

export function updateAll(items: UpdateItem[]) {
  for (const item of items) if (item.state === "available" || item.state === "failed") update(item);
}
