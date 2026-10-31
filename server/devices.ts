import { z } from "zod";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DeviceAction,
  DeviceInfo,
  DevicePreview,
} from "../shared/devices";
import type { ToolResult } from "./session";
import { DeviceRuntime, type DeviceAgent } from "./device-runtime";

const id = z.string().min(1).max(256);
const pixel = z.number().finite().min(0).max(20_000);
const listInput = z.object({});
const openInput = z.object({
  platform: z.enum(["ios", "android"]),
  deviceId: id.optional(),
});
const targetInput = z.object({ deviceId: id.optional() });
const snapshotInput = targetInput.extend({
  includeTree: z.boolean().optional(),
  displayOnly: z.boolean().optional(),
});
const actInput = targetInput.extend({
  snapshotId: id.optional(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tap"), x: pixel, y: pixel }),
    z.object({
      kind: z.literal("swipe"),
      fromX: pixel,
      fromY: pixel,
      toX: pixel,
      toY: pixel,
      durationMs: z.number().int().min(100).max(3000).optional(),
    }),
    z.object({ kind: z.literal("type"), text: z.string().min(1).max(2000) }),
    z.object({
      kind: z.literal("key"),
      key: z.enum([
        "home",
        "back",
        "recents",
        "enter",
        "delete",
        "escape",
        "tab",
      ]),
    }),
    z.object({
      kind: z.literal("openApp"),
      app: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[\w.-]+$/),
    }),
    z.object({ kind: z.literal("fill"), ref: id, text: z.string().max(2000) }),
  ]),
});
const closeInput = targetInput.extend({ shutdown: z.boolean().optional() });
export const DEVICE_TOOLS = {
  device_list: {
    description:
      "List local iOS simulators and Android emulators and this chat's open devices. Metadata only; does not boot a device or install tools.",
    input: listInput.shape,
  },
  device_open: {
    description:
      "Open an iOS simulator or Android emulator in Tack's device sidebar, booting it in the background if needed. Omit deviceId to let Tack choose a running or default device. Does not move the Mac mouse or open a native simulator window. Native device tools are prepared automatically on first use.",
    input: openInput.shape,
  },
  device_snapshot: {
    description:
      "Read an open device's PNG screen and accessibility tree. Returns snapshotId and semantic refs when available. Coordinates in device_act use this PNG's pixels. includeTree:false is a cheap screen-only refresh. First semantic access can prepare an iOS test runner.",
    input: snapshotInput.shape,
  },
  device_act: {
    description:
      "Operate an open simulator/emulator, in the background. Tap/swipe coordinates use the latest PNG pixels; include snapshotId when acting from an observation. Open apps by bundle/package ID; fill a native ref or type into the focused field. Returns native evidence and a fresh screen; verify the change before dependent actions. Never blindly repeat partially delivered input.",
    input: actInput.shape,
  },
  device_close: {
    description:
      "Close a device preview and release this chat's control. The device keeps running unless shutdown:true; Tack only shuts down devices it booted itself.",
    input: closeInput.shape,
  },
};

type Snapshot = {
  id: string;
  width: number;
  height: number;
  generation?: number;
  refs: Map<string, string>;
};
type Context = {
  device: DeviceInfo;
  key: string;
  agent?: DeviceAgent;
  sdkApp?: string;
  image?: string;
  snapshot?: Snapshot;
  display?: Snapshot;
  receipts: Map<string, Snapshot>;
  input?: DeviceInput;
};
type State = {
  controller: AbortController;
  queue: Promise<unknown>;
  contexts: Map<string, Context>;
  current?: string;
  status: DevicePreview["status"];
  error?: string;
  interrupting?: Promise<void>;
  closing?: Promise<void>;
};
const text = (value: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});

export class DeviceService {
  private states = new Map<string, State>();
  private owners = new Map<string, string>();
  private devices: DeviceInfo[] = [];
  private available = false;
  private runtime: DeviceRuntime;
  private disposed = false;
  constructor(
    directory: string,
    private notify: (
      threadId: string,
      preview: DevicePreview,
    ) => void = () => {},
    env: Record<string, string | undefined> = process.env,
    runtime?: DeviceRuntime,
  ) {
    this.runtime =
      runtime ?? new DeviceRuntime(join(directory, "devices"), env);
  }
  private state(threadId: string) {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        controller: new AbortController(),
        queue: Promise.resolve(),
        contexts: new Map(),
        status: "idle",
      };
      this.states.set(threadId, state);
    }
    return state;
  }
  getPreview(threadId: string): DevicePreview {
    const state = this.states.get(threadId),
      context = state?.current ? state.contexts.get(state.current) : undefined;
    return {
      available: this.available,
      devices: this.devices,
      open: [...(state?.contexts.values() ?? [])].map((c) => c.device),
      currentDeviceId: context?.device.id,
      image: context?.image,
      width: context?.display?.width,
      height: context?.display?.height,
      snapshotId: context?.display?.id,
      status: state?.status ?? "idle",
      error: state?.error,
    };
  }
  private emit(threadId: string) {
    try {
      this.notify(threadId, this.getPreview(threadId));
    } catch {}
  }
  async execute(
    threadId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.disposed)
      return { ...text("Device support is stopped."), isError: true };
    const state = this.state(threadId),
      controller = state.controller,
      scope = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    if (state.closing)
      return { ...text("This device chat is closing."), isError: true };
    const run = state.queue
      .catch(() => {})
      .then(async () => {
        scope.throwIfAborted();
        state.error = undefined;
        switch (name) {
          case "device_list": {
            listInput.parse(input);
            const inventory = await this.runtime.inventory(scope);
            this.devices = inventory.devices;
            this.available = inventory.available;
            this.emit(threadId);
            return text({ ...inventory, open: this.getPreview(threadId).open });
          }
          case "device_open": {
            const parsed = openInput.parse(input);
            state.status = "starting";
            this.emit(threadId);
            const inventory = await this.runtime.inventory(scope);
            this.devices = inventory.devices;
            this.available = inventory.available;
            const candidates = this.devices.filter(
              (d) => d.platform === parsed.platform,
            );
            const device = parsed.deviceId
              ? candidates.find((d) => d.id === parsed.deviceId)
              : (candidates.find((d) => d.booted) ??
                candidates.find((d) => !/(?:QA|test)/i.test(d.name)) ??
                candidates[0]);
            if (!device)
              throw Error(
                `No ${parsed.platform} ${parsed.deviceId ? `device ${parsed.deviceId}` : "simulator or emulator"} is available. Use device_list to inspect the installed runtimes.`,
              );
            const key = `${device.platform}:${device.platform === "ios" ? device.id : device.name}`;
            const owner = this.owners.get(key);
            if (owner && owner !== threadId)
              throw Error("This device is in use by another Tack chat.");
            let context = [...state.contexts.values()].find(
              (c) => c.key === key,
            );
            if (!context) {
              this.owners.set(key, threadId);
              try {
                await this.runtime.ensure(scope);
                const running = await this.runtime.boot(device, scope);
                scope.throwIfAborted();
                await this.runtime.attach(running, scope);
                context = { device: running, key, receipts: new Map() };
                state.contexts.set(running.id, context);
              } catch (error) {
                if (this.owners.get(key) === threadId) this.owners.delete(key);
                throw error;
              }
            }
            state.current = context.device.id;
            state.status = "ready";
            scope.throwIfAborted();
            return this.snapshot(threadId, state, context, false, scope);
          }
          case "device_snapshot": {
            const parsed = snapshotInput.parse(input);
            return this.snapshot(
              threadId,
              state,
              this.context(state, parsed.deviceId),
              parsed.includeTree ?? true,
              scope,
              parsed.displayOnly ?? false,
            );
          }
          case "device_act": {
            const parsed = actInput.parse(input),
              context = this.context(state, parsed.deviceId);
            state.current = context.device.id;
            const snapshot = parsed.snapshotId
              ? context.receipts.get(parsed.snapshotId)
              : context.display;
            if (!snapshot)
              throw Error(
                "Device screenshot expired. Read device_snapshot before acting.",
              );
            const action = parsed.action as DeviceAction;
            if (action.kind === "tap")
              this.checkPoint(snapshot, action.x, action.y);
            if (action.kind === "swipe") {
              this.checkPoint(snapshot, action.fromX, action.fromY);
              this.checkPoint(snapshot, action.toX, action.toY);
            }
            context.snapshot = undefined;
            context.display = undefined;
            context.receipts.clear();
            scope.throwIfAborted();
            let evidence: unknown;
            try {
              if (action.kind === "openApp") {
                context.agent ??= this.runtime.createAgent(context.device);
                evidence = await context.agent.call(
                  "openApp",
                  { app: action.app },
                  scope,
                );
                context.sdkApp = action.app;
              } else if (action.kind === "fill") {
                const ref =
                  snapshot.refs.get(action.ref) ??
                  snapshot.refs.get(action.ref.replace(/^@/, ""));
                if (!ref)
                  throw Error(
                    "The ref is not from this device's latest semantic snapshot. Use device_snapshot or tap/type.",
                  );
                await this.ensureAgent(context, scope);
                evidence = await context.agent!.call(
                  "fill",
                  { ref, text: action.text },
                  scope,
                );
              } else if (action.kind === "type") {
                await this.ensureAgent(context, scope);
                evidence = await context.agent!.call(
                  "type",
                  { text: action.text },
                  scope,
                );
              } else if (context.device.platform === "android") {
                await this.runtime.androidInput(
                  context.device,
                  action,
                  snapshot,
                  scope,
                );
                evidence = {
                  delivery: "sent",
                  effect: "unverified",
                  note: "Android input command completed. Verify the resulting screen before repeating.",
                };
              } else {
                context.input ??= new DeviceInput(this.runtime, context.device);
                await context.input.act(action, snapshot, scope);
                evidence = {
                  delivery: "sent",
                  effect: "unverified",
                  note: "Input reached the device input transport. Verify the resulting screen before repeating.",
                };
              }
            } catch (error) {
              const result = {
                ...text({
                  error: error instanceof Error ? error.message : String(error),
                  native: (error as any)?.details,
                  delivery: "unknown",
                  hint: "An action may have partially executed. Observe again before retrying.",
                }),
                isError: true,
              };
              if (!scope.aborted)
                try {
                  const observed = await this.snapshot(
                    threadId,
                    state,
                    context,
                    false,
                    scope,
                  );
                  result.content.push(...(observed.content as any));
                } catch {}
              return result;
            }
            const outcome = text({ device: context.device, evidence });
            try {
              const observed = await this.snapshot(
                threadId,
                state,
                context,
                false,
                scope,
              );
              outcome.content.push(...observed.content);
            } catch (error) {
              outcome.isError = true;
              outcome.content.push({
                type: "text",
                text: `Post-action observation failed: ${String(error)}. The action may have executed; observe before retrying.`,
              });
            }
            return outcome;
          }
          case "device_close": {
            const parsed = closeInput.parse(input);
            const contexts = parsed.deviceId
              ? [this.context(state, parsed.deviceId)]
              : [...state.contexts.values()];
            for (const context of contexts) {
              if (parsed.shutdown)
                await this.runtime.shutdown(context.device, scope);
              await context.input?.close();
              await context.agent?.close();
              state.contexts.delete(context.device.id);
              if (this.owners.get(context.key) === threadId)
                this.owners.delete(context.key);
            }
            if (!state.current || !state.contexts.has(state.current))
              state.current = [...state.contexts.keys()].at(-1);
            state.status = state.contexts.size ? "ready" : "idle";
            this.emit(threadId);
            return text(this.getPreview(threadId));
          }
          default:
            throw Error("Unknown device tool.");
        }
      });
    state.queue = run;
    try {
      return await run;
    } catch (error) {
      if (state.controller === controller) {
        state.status = state.contexts.size ? "ready" : "error";
        state.error = scope.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error);
        this.emit(threadId);
      }
      return {
        ...text(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  }
  private context(state: State, id?: string) {
    const context = state.contexts.get(id ?? state.current ?? "");
    if (!context)
      throw Error("Use device_open before reading or acting on this device.");
    return context;
  }
  private checkPoint(snapshot: Snapshot, x: number, y: number) {
    if (x >= snapshot.width || y >= snapshot.height)
      throw Error("Coordinates are outside the current device screenshot.");
  }
  private async ensureAgent(context: Context, signal: AbortSignal) {
    context.agent ??= this.runtime.createAgent(context.device);
    if (context.sdkApp) return;
    const foreground = (await this.runtime.foreground(
      context.device,
      signal,
    )) as any;
    const app =
      foreground.bundleId ?? foreground.bundleID ?? foreground.package;
    if (typeof app !== "string" || !app)
      throw Error(
        "Open the target app with device_act openApp before semantic text input.",
      );
    await context.agent.call("openApp", { app }, signal);
    context.sdkApp = app;
  }
  private async snapshot(
    threadId: string,
    state: State,
    context: Context,
    includeTree: boolean,
    signal: AbortSignal,
    displayOnly = false,
  ): Promise<ToolResult> {
    const shot = await this.runtime.screenshot(context.device, signal);
    signal.throwIfAborted();
    const previous = context.snapshot;
    const snapshot: Snapshot = {
      id: crypto.randomUUID(),
      width: shot.width,
      height: shot.height,
      refs: new Map(),
    };
    context.image = `data:image/png;base64,${shot.png.toString("base64")}`;
    context.display = snapshot;
    if (!displayOnly) {
      context.snapshot = snapshot;
      context.receipts.clear();
    }
    context.receipts.set(snapshot.id, snapshot);
    for (const [id] of context.receipts) {
      if (context.receipts.size <= 9) break;
      if (id !== context.snapshot?.id) context.receipts.delete(id);
    }
    state.current = context.device.id;
    state.status = "ready";
    this.emit(threadId);
    let tree: unknown, treeError: string | undefined;
    if (includeTree && !displayOnly) {
      try {
        if (context.sdkApp) {
          context.agent ??= this.runtime.createAgent(context.device);
          const native = await context.agent.call("snapshot", {}, signal);
          snapshot.generation = native.refsGeneration;
          const visit = (nodes: any[]) => {
            for (const n of nodes) {
              if (typeof n.ref === "string")
                snapshot.refs.set(
                  n.ref,
                  snapshot.generation === undefined
                    ? n.ref
                    : `@${n.ref.replace(/^@/, "")}~s${snapshot.generation}`,
                );
              if (Array.isArray(n.children)) visit(n.children);
            }
          };
          visit(native.nodes ?? []);
          tree = native;
        } else tree = await this.runtime.ax(context.device, signal);
      } catch (error) {
        signal.throwIfAborted();
        treeError = error instanceof Error ? error.message : String(error);
      }
    } else if (previous) {
      snapshot.refs = previous.refs;
      snapshot.generation = previous.generation;
    }
    signal.throwIfAborted();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            device: context.device,
            snapshotId: snapshot.id,
            width: shot.width,
            height: shot.height,
            tree,
            treeError,
          }),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: shot.png.toString("base64"),
        },
      ],
    };
  }
  async interrupt(threadId: string) {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.interrupting) return state.interrupting;
    const controller = state.controller;
    controller.abort();
    const queue = state.queue;
    const work = (async () => {
      await Promise.all(
        [...state.contexts.values()].map(async (context) => {
          await context.input?.close();
          const agent = context.agent;
          if (agent) {
            await agent.close();
            if (context.agent === agent) {
              context.agent = undefined;
              context.sdkApp = undefined;
            }
          }
          context.snapshot = undefined;
          context.receipts.clear();
          if (context.display) {
            context.display = {
              ...context.display,
              id: crypto.randomUUID(),
              refs: new Map(),
              generation: undefined,
            };
            context.receipts.set(context.display.id, context.display);
          }
        }),
      );
      await queue.catch(() => {});
      if (state.controller === controller) {
        state.controller = new AbortController();
        state.status = state.contexts.size ? "ready" : "idle";
        state.error = undefined;
        this.emit(threadId);
      }
    })();
    state.interrupting = work;
    try {
      await work;
    } finally {
      if (state.interrupting === work) state.interrupting = undefined;
    }
  }
  async closeThread(threadId: string) {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.closing) return state.closing;
    const work = (async () => {
      await this.interrupt(threadId);
      for (const context of state.contexts.values()) {
        await context.input?.close();
        await context.agent?.close();
        if (this.owners.get(context.key) === threadId)
          this.owners.delete(context.key);
      }
      if (this.states.get(threadId) === state) this.states.delete(threadId);
      this.emit(threadId);
    })();
    state.closing = work;
    await work;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(
      [...this.states.keys()].map((id) => this.closeThread(id)),
    );
    await this.runtime.dispose();
  }
}

class DeviceInput {
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private closing?: Promise<void>;
  private last?: { x: number; y: number };
  private config?: { width: number; height: number; orientation: string };
  constructor(
    private runtime: DeviceRuntime,
    private device: DeviceInfo,
  ) {}
  private async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.closing;
    signal.throwIfAborted();
    if (this.socket?.readyState === WebSocket.OPEN && this.ready)
      return this.ready;
    const socket = new WebSocket(
      this.runtime.inputUrl(this.device),
      this.runtime.inputProtocols(this.device),
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(Error("Device input did not connect."));
      }, 10_000);
      const finish = (fn: () => void) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        fn();
      };
      const abort = () => {
        socket.close();
        finish(() => reject(Error("Device input canceled.")));
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        if (this.device.platform === "android") finish(resolve);
      };
      socket.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(e.data);
        if (bytes[0] === 0x82)
          try {
            this.config = JSON.parse(
              new TextDecoder().decode(bytes.subarray(1)),
            );
          } catch {}
        if (bytes[0] === 0x83) finish(resolve);
      };
      socket.onerror = () =>
        finish(() => reject(Error("Device input connection failed.")));
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.ready = undefined;
        }
        finish(() => reject(Error("Device input connection closed.")));
      };
    });
    return this.ready;
  }
  private send(type: number | undefined, payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw Error("Device input is disconnected.");
    const data = JSON.stringify(payload);
    if (type === undefined) this.socket.send(data);
    else {
      const text = new TextEncoder().encode(data),
        bytes = new Uint8Array(text.length + 1);
      bytes[0] = type;
      bytes.set(text, 1);
      this.socket.send(bytes);
    }
  }
  private point(x: number, y: number, snapshot: Snapshot) {
    let p = { x: x / snapshot.width, y: y / snapshot.height };
    if (
      this.device.platform !== "ios" ||
      !this.config ||
      this.config.width > this.config.height
    )
      return p;
    switch (this.config.orientation) {
      case "landscape_left":
        return { x: p.y, y: 1 - p.x };
      case "landscape_right":
        return { x: 1 - p.y, y: p.x };
      case "portrait_upside_down":
        return { x: 1 - p.x, y: 1 - p.y };
      default:
        return p;
    }
  }
  private touch(phase: "begin" | "move" | "end", p: { x: number; y: number }) {
    if (this.device.platform === "ios") this.send(3, { type: phase, ...p });
    else
      this.send(undefined, {
        type: "touch",
        action: phase === "begin" ? "down" : phase === "move" ? "move" : "up",
        ...p,
      });
    this.last = phase === "end" ? undefined : p;
  }
  async act(action: DeviceAction, snapshot: Snapshot, signal: AbortSignal) {
    await this.connect(signal);
    signal.throwIfAborted();
    const abort = () => {
      void this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (action.kind === "tap") {
        const p = this.point(action.x, action.y, snapshot);
        this.touch("begin", p);
        await delay(60, undefined, { signal });
        this.touch("end", p);
      } else if (action.kind === "swipe") {
        const from = this.point(action.fromX, action.fromY, snapshot),
          to = this.point(action.toX, action.toY, snapshot),
          steps = 12;
        this.touch("begin", from);
        for (let i = 1; i <= steps; i++) {
          await delay((action.durationMs ?? 400) / steps, undefined, {
            signal,
          });
          this.touch("move", {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          });
        }
        this.touch("end", to);
      } else if (action.kind === "type") {
        let chunk = "";
        for (const character of action.text) {
          if (Buffer.byteLength(chunk + character) > 280) {
            this.send(undefined, { type: "text", text: chunk });
            chunk = "";
          }
          chunk += character;
        }
        if (chunk) this.send(undefined, { type: "text", text: chunk });
      } else if (action.kind === "key") {
        if (this.device.platform === "android") {
          const buttons = {
            home: "home",
            back: "back",
            recents: "recents",
          } as const;
          if (action.key in buttons)
            this.send(undefined, {
              type: buttons[action.key as keyof typeof buttons],
            });
          else
            this.send(undefined, {
              type: "key",
              keycode: { enter: 66, delete: 67, escape: 111, tab: 61 }[
                action.key as "enter"
              ],
            });
        } else if (action.key === "home" || action.key === "recents")
          this.send(4, {
            button: action.key === "home" ? "home" : "app_switcher",
          });
        else if (action.key === "back")
          throw Error(
            "iOS has no hardware Back button. Tap the app's Back control.",
          );
        else {
          const usage = { enter: 40, delete: 42, escape: 41, tab: 43 }[
            action.key
          ];
          this.send(6, { type: "down", usage });
          this.send(6, { type: "up", usage });
        }
      } else throw Error("Unsupported device input action.");
      await delay(300, undefined, { signal });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  close() {
    if (this.closing) return this.closing;
    const socket = this.socket;
    if (this.last)
      try {
        this.touch("end", this.last);
      } catch {}
    this.socket = undefined;
    this.ready = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED)
      return Promise.resolve();
    const work = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      socket.addEventListener("close", finish, { once: true });
      try {
        socket.close();
      } catch {
        finish();
      }
    });
    this.closing = work;
    void work.finally(() => {
      if (this.closing === work) this.closing = undefined;
    });
    return work;
  }
}
