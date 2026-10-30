// Thin wrappers over Tauri APIs, with plain-browser fallbacks for `bun run dev:web`.

import { invoke, isTauri } from "@tauri-apps/api/core";

export const inTauri = isTauri();

export async function serverUrl(): Promise<string> {
  if (!inTauri) return "ws://127.0.0.1:7357/ws";
  const { port, token } = await invoke<{ port: number; token: string }>("server_info");
  return `ws://127.0.0.1:${port}/ws?token=${token}`;
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return window.prompt("Project folder path");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Add project" });
  return typeof picked === "string" ? picked : null;
}

export async function openExternal(url: string) {
  if (!inTauri) return void window.open(url, "_blank", "noopener");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

// File paths dropped onto the window. The browser fallback can't see paths, so it's Tauri only.
export async function onFileDrop(handler: (paths: string[]) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") handler(e.payload.paths);
  });
}
