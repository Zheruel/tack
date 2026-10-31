// WebSocket client: typed requests plus a stream of server events. Reconnects on drop.

import type { Event, Method, Requests, ServerFrame } from "../../shared/protocol";
import { serverUrl } from "./native";

type Listener = (e: Event) => void;

let ws: WebSocket | undefined;
let nextId = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const listeners = new Set<Listener>();
const connectListeners = new Set<() => void>();

export function call<M extends Method>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
    const id = ++nextId;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

export function onEvent(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function onConnect(fn: () => void) {
  connectListeners.add(fn);
  return () => void connectListeners.delete(fn);
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
// A connection must stay open this long before the backoff resets, so a server that accepts and then crashes keeps backing off.
const STABLE_MS = 10_000;

// Exponential backoff with jitter: 500ms doubling up to 30s, each delay randomized into its upper half.
function reconnectDelay(attempt: number): number {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return cap / 2 + Math.random() * (cap / 2);
}

export async function connect() {
  const url = await serverUrl();
  let attempt = 0;
  const open = () => {
    const socket = new WebSocket(url);
    let stable: ReturnType<typeof setTimeout> | undefined;
    socket.onopen = () => {
      ws = socket;
      stable = setTimeout(() => (attempt = 0), STABLE_MS);
      for (const fn of connectListeners) fn();
    };
    socket.onmessage = (m) => {
      const frame = JSON.parse(m.data) as ServerFrame;
      if ("event" in frame) {
        for (const fn of listeners) fn(frame.event);
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      "error" in frame ? p.reject(new Error(frame.error)) : p.resolve(frame.result);
    };
    socket.onclose = () => {
      clearTimeout(stable);
      if (ws === socket) ws = undefined;
      for (const p of pending.values()) p.reject(new Error("Disconnected"));
      pending.clear();
      setTimeout(open, reconnectDelay(attempt++));
    };
  };
  open();
}
