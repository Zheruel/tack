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

export async function connect() {
  const url = await serverUrl();
  const open = () => {
    const socket = new WebSocket(url);
    socket.onopen = () => {
      ws = socket;
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
      if (ws === socket) ws = undefined;
      for (const p of pending.values()) p.reject(new Error("Disconnected"));
      pending.clear();
      setTimeout(open, 500);
    };
  };
  open();
}
