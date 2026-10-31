import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopStatus } from "../shared/protocol";
import type { SessionEvents, ToolResult } from "./session";
import {
  desktopAvailable,
  desktopData,
  startDesktopDriver,
  type DesktopDriver,
  type DesktopReply,
} from "./desktop-driver";

const appId = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[\w-]+(?:\.[\w-]+)+$/)
  .describe("Exact macOS bundle ID from desktop_apps");
const windowId = z.number().int().positive();
const pixel = z.number().finite().min(0).max(100_000);
const token = z.string().min(1).max(256);
const position = z.union([
  z.object({ elementToken: token }),
  z.object({ x: pixel, y: pixel }),
]);
const modifiers = z
  .array(z.enum(["cmd", "shift", "option", "ctrl", "fn"]))
  .max(5)
  .optional();
const appsInput = z.object({ query: z.string().max(200).optional() });
const openInput = z.object({ app: appId, reason: z.string().min(1).max(500) });
const snapshotInput = z.object({
  app: appId,
  windowId,
  includeImage: z.boolean().optional(),
});
const actInput = z.object({
  app: appId,
  windowId,
  snapshotId: token.describe(
    "Tack snapshotId from the latest observation of this window",
  ),
  foreground: z
    .boolean()
    .optional()
    .describe(
      "Default false: background input. Set true when background cannot work: Tack brings the exact window forward and keeps using the agent's own cursor, without moving the user's mouse. Do not ask the user to choose. Observe before retrying uncertain or partial input.",
    ),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("click"),
      position,
      button: z.enum(["left", "right", "middle"]).optional(),
      count: z.number().int().min(1).max(3).optional(),
      modifiers,
    }),
    z.object({
      kind: z.literal("type"),
      text: z.string().min(1).max(2000),
      elementToken: token.optional(),
    }),
    z.object({
      kind: z.literal("key"),
      key: z.string().min(1).max(40),
      modifiers,
    }),
    z.object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(20).optional(),
      position: position.optional(),
    }),
    z.object({
      kind: z.literal("drag"),
      fromX: pixel,
      fromY: pixel,
      toX: pixel,
      toY: pixel,
    }),
    z.object({
      kind: z.literal("setValue"),
      elementToken: token,
      value: z.string().max(2000),
    }),
  ]),
});
const releaseInput = z.object({});

export const DESKTOP_TOOLS = {
  desktop_apps: {
    description:
      "Find installed Mac apps by name or bundle ID. Metadata only; does not grant access or capture a screen. Use Tack's preview_* tools for web work.",
    input: appsInput.shape,
  },
  desktop_open: {
    description:
      "Open a Mac app for the user's desktop task in the background and list its windows. Tack handles app access and macOS setup. Full access proceeds automatically. Use the built-in preview_* sidebar browser for web/Chrome work. Choose the needed native app yourself.",
    input: openInput.shape,
  },
  desktop_snapshot: {
    description:
      "Read one approved app window: accessibility tree and optional image (default true). Returns a fresh snapshotId for desktop_act. Row [N] uses elementTokenPrefix + N. Any read or action can expire previous snapshots; re-read after user interaction or an uncertain action.",
    input: snapshotInput.shape,
  },
  desktop_act: {
    description:
      "Act on an open app window using its latest snapshotId. Try background input first. Prefer element tokens; use screenshot pixels for canvas or controls absent from the tree. Returns native outcome evidence and a fresh observation. If background cannot complete the task, choose foreground:true automatically on the next grounded action; no user confirmation is needed for focus. Verify changes before dependent actions, especially Save or Submit. Never blindly replay uncertain or partial input.",
    input: actInput.shape,
  },
  desktop_release: {
    description:
      "End this chat's desktop access and stop its Cua runtimes. Does not quit the apps. Future access requires approval again.",
    input: releaseInput.shape,
  },
};

interface App {
  bundleId: string;
  name: string;
  pid?: number;
  running: boolean;
}
interface Snapshot {
  id: string;
  nativeId?: string;
  captureId?: string;
  pid: number;
  width?: number;
  height?: number;
}
interface Context {
  app: App;
  driver: Promise<DesktopDriver>;
  snapshots: Map<number, Snapshot>;
}
interface State {
  controller: AbortController;
  grants: Map<string, App>;
  contexts: Map<string, Context>;
  queue: Promise<unknown>;
  closing: Promise<unknown>;
  needsSetup?: boolean;
}
const text = (value: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});

export class DesktopService {
  private states = new Map<string, State>();
  private owners = new Map<string, { threadId: string; context: Context }>();
  private inputQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private notify: (
      threadId: string,
      status: DesktopStatus,
    ) => void = () => {},
    private createDriver = startDesktopDriver,
    private setupTimeoutMs = 90_000,
  ) {}

  status(threadId: string): DesktopStatus {
    const state = this.states.get(threadId);
    return {
      available: desktopAvailable(),
      apps: [...(state?.grants.values() ?? [])].map(({ bundleId, name }) => ({
        bundleId,
        name,
      })),
      active: !!state?.contexts.size,
      ...(state?.needsSetup ? { needsSetup: true } : {}),
    };
  }

  private state(threadId: string) {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        controller: new AbortController(),
        grants: new Map(),
        contexts: new Map(),
        queue: Promise.resolve(),
        closing: Promise.resolve(),
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  async execute(
    threadId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
    approve?: SessionEvents["approve"],
  ): Promise<ToolResult> {
    const state = this.state(threadId);
    const controller = state.controller;
    const scope = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const run = state.queue
      .catch(() => {})
      .then(async () => {
        await state.closing;
        scope.throwIfAborted();
        switch (name) {
          case "desktop_apps": {
            const { query = "" } = appsInput.parse(input);
            const apps = await this.apps(scope);
            const matches = apps.filter((app) =>
              `${app.name} ${app.bundleId}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            );
            return text({
              apps: matches
                .slice(0, 30)
                .map(({ name, bundleId, running }) => ({
                  name,
                  bundleId,
                  running,
                })),
              total: matches.length,
            });
          }
          case "desktop_open": {
            const { app: bundleId, reason } = openInput.parse(input);
            const app = (await this.apps(scope)).find(
              (app) => app.bundleId === bundleId,
            );
            if (!app)
              throw new Error(
                "App not found. Use desktop_apps and its exact bundleId.",
              );
            if (bundleId === "dev.tack.app")
              throw new Error("Computer use cannot control its own Tack host.");
            const owner = this.owners.get(bundleId);
            if (owner && owner.threadId !== threadId)
              throw new Error(
                "Another Tack chat is using this app. Wait for it to finish before opening it here.",
              );
            if (!state.grants.has(bundleId)) {
              if (
                !approve ||
                !(await approve(
                  "DesktopApp",
                  { app: app.name, bundleId, reason },
                  scope,
                ))
              )
                throw new Error(
                  "The user declined desktop app access. Do not retry or use another tool to control this app.",
                );
              scope.throwIfAborted();
              state.grants.set(bundleId, app);
              this.notify(threadId, this.status(threadId));
            }
            return this.serial(scope, async () => {
              const context = await this.context(threadId, state, app, scope);
              const driver = await context.driver;
              await this.permissions(threadId, state, driver, scope);
              let windows = app.running
                ? await this.windows(context, scope)
                : undefined;
              if (!windows || desktopData(windows).windows.length === 0) {
                const launched = desktopData(
                  await driver.call(
                    "launch_app",
                    { bundle_id: bundleId },
                    scope,
                  ),
                );
                if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0)
                  throw new Error(
                    "The app did not return a running process. Open it, then try desktop_open again.",
                  );
                context.app = { ...app, pid: launched.pid, running: true };
                windows = await this.windows(context, scope);
              }
              return windows;
            });
          }
          case "desktop_snapshot": {
            const parsed = snapshotInput.parse(input);
            return this.serial(scope, async () => {
              const context = this.openContext(state, parsed.app);
              return this.snapshot(
                context,
                parsed.windowId,
                parsed.includeImage ?? true,
                scope,
              );
            });
          }
          case "desktop_act": {
            const parsed = actInput.parse(input);
            return this.serial(scope, async () => {
              const context = this.openContext(state, parsed.app);
              const snapshot = context.snapshots.get(parsed.windowId);
              if (!snapshot || snapshot.id !== parsed.snapshotId)
                throw new Error(
                  "Snapshot expired. Take a fresh desktop_snapshot before acting.",
                );
              const action = parsed.action;
              const element =
                "elementToken" in action
                  ? action.elementToken
                  : "position" in action &&
                      action.position &&
                      "elementToken" in action.position
                    ? action.position.elementToken
                    : undefined;
              if (
                element &&
                (!snapshot.nativeId ||
                  !element.startsWith(`${snapshot.nativeId}:`))
              )
                throw new Error(
                  "Element token is not from this window's latest snapshot.",
                );
              const point =
                "position" in action &&
                action.position &&
                "x" in action.position
                  ? action.position
                  : undefined;
              if ((point || action.kind === "drag") && !snapshot.captureId)
                throw new Error(
                  "Pixel input needs a fresh desktop_snapshot with includeImage true and a valid capture receipt.",
                );
              if (point) this.checkPoint(snapshot, point.x, point.y);
              if (action.kind === "drag") {
                this.checkPoint(snapshot, action.fromX, action.fromY);
                this.checkPoint(snapshot, action.toX, action.toY);
              }
              await this.windows(context, scope, parsed.windowId, snapshot.pid);
              scope.throwIfAborted();
              // Consume before dispatch, including failures. A second queued action cannot reuse the observation.
              context.snapshots.clear();
              const target = {
                kind: "window",
                pid: snapshot.pid,
                window_id: parsed.windowId,
              };
              // Select delivery before dispatch. An unverified background action must never be replayed as a fallback.
              const driver = await context.driver;
              if (parsed.foreground) {
                desktopData(
                  await driver.call(
                    "bring_to_front",
                    { pid: snapshot.pid, window_id: parsed.windowId },
                    scope,
                  ),
                );
                await this.windows(
                  context,
                  scope,
                  parsed.windowId,
                  snapshot.pid,
                );
              }
              // Activation is separate from delivery: Cua's foreground HID path moves the real mouse.
              // PID-routed events use Cua's own session cursor, including on a frontmost window.
              const args: Record<string, unknown> = {
                target,
                delivery_mode: "background",
              };
              if (element) args.element_token = element;
              if (point) Object.assign(args, point);
              let tool: string;
              switch (action.kind) {
                case "click":
                  tool = "click";
                  Object.assign(args, {
                    button: action.button,
                    count: action.count,
                    modifier: action.modifiers,
                  });
                  if (point) args.capture_id = snapshot.captureId;
                  break;
                case "type":
                  tool = "type_text";
                  args.text = action.text;
                  break;
                case "key":
                  tool = "press_key";
                  Object.assign(args, {
                    key: action.key,
                    modifiers: action.modifiers,
                  });
                  break;
                case "scroll":
                  tool = "scroll";
                  Object.assign(args, {
                    direction: action.direction,
                    amount: action.amount,
                  });
                  break;
                case "drag":
                  tool = "drag";
                  Object.assign(args, {
                    from_x: action.fromX,
                    from_y: action.fromY,
                    to_x: action.toX,
                    to_y: action.toY,
                  });
                  break;
                case "setValue":
                  tool = "set_value";
                  // Cua 0.38's set_value addresses the window through its element token, not a typed target.
                  delete args.target;
                  delete args.delivery_mode;
                  Object.assign(args, {
                    pid: snapshot.pid,
                    value: action.value,
                  });
                  break;
              }
              const result = await driver.call(tool, args, scope);
              const outcome: ToolResult = {
                content: [...result.content],
                isError: result.isError,
              };
              if (parsed.foreground)
                outcome.content.push({
                  type: "text",
                  text: "The window was brought forward; input still uses the agent cursor, leaving the user's mouse untouched. If the new observation shows no effect, do not repeat the action blindly. System-pointer delivery is unavailable in Tack.",
                });
              // Codex's dynamic-tool adapter forwards content, so evidence must be model-visible text.
              if (result.structuredContent)
                outcome.content.push({
                  type: "text",
                  text: `Native action outcome: ${JSON.stringify(result.structuredContent)}`,
                });
              try {
                const observed = await this.snapshot(
                  context,
                  parsed.windowId,
                  true,
                  scope,
                );
                outcome.content.push(...observed.content);
                outcome.isError ||= observed.isError;
              } catch (error) {
                outcome.content.push({
                  type: "text",
                  text: `Post-action observation failed: ${error instanceof Error ? error.message : String(error)}. The action may have executed; observe before retrying.`,
                });
                outcome.isError = true;
              }
              return outcome;
            });
          }
          case "desktop_release":
            releaseInput.parse(input);
            await this.finishTurn(threadId, true);
            return text(
              "Desktop access ended for this chat. Apps remain open.",
            );
          default:
            throw new Error("Unknown desktop tool.");
        }
      });
    state.queue = run;
    try {
      return await run;
    } catch (error) {
      if (state.controller === controller) await this.finishTurn(threadId);
      return {
        ...text(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  }

  private serial<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const work = this.inputQueue
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return run();
      });
    this.inputQueue = work;
    return work;
  }

  private async permissions(
    threadId: string,
    state: State,
    driver: DesktopDriver,
    signal: AbortSignal,
  ) {
    const deadline = Date.now() + this.setupTimeoutMs;
    while (true) {
      signal.throwIfAborted();
      const permissions = desktopData(
        await driver.call("check_permissions", {}, signal),
      );
      const ready =
        permissions.accessibility === true &&
        permissions.screen_recording === true;
      if (state.needsSetup !== !ready) {
        state.needsSetup = !ready;
        this.notify(threadId, this.status(threadId));
      }
      if (ready) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          "macOS still needs permission to control apps and read the screen. Complete Tack's permission setup in System Settings. If macOS requests a restart, reopen Tack. No app input was sent.",
        );
      await delay(Math.min(500, remaining), undefined, { signal });
    }
  }

  private async apps(signal: AbortSignal): Promise<App[]> {
    const driver = await this.createDriver([], signal);
    try {
      const data = desktopData(await driver.call("list_apps", {}, signal));
      if (!Array.isArray(data.apps))
        throw new Error("Cua returned an unreadable app list.");
      const schema = z.object({
        bundle_id: appId,
        name: z.string(),
        pid: z.number().int().nonnegative().nullish(),
        running: z.boolean(),
      });
      return data.apps.flatMap((value: unknown) => {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? [
              {
                name: parsed.data.name,
                bundleId: parsed.data.bundle_id,
                running: parsed.data.running && !!parsed.data.pid,
                pid: parsed.data.pid || undefined,
              },
            ]
          : [];
      });
    } finally {
      await driver.close();
    }
  }

  private async context(
    threadId: string,
    state: State,
    app: App,
    signal: AbortSignal,
  ) {
    const existing = state.contexts.get(app.bundleId);
    if (existing) return existing;
    const owner = this.owners.get(app.bundleId);
    if (owner && owner.threadId !== threadId)
      throw new Error(
        "Another Tack chat is using this app. Wait for it to finish.",
      );
    const context: Context = {
      app,
      driver: this.createDriver([app.bundleId], signal),
      snapshots: new Map(),
    };
    state.contexts.set(app.bundleId, context);
    this.owners.set(app.bundleId, { threadId, context });
    this.notify(threadId, this.status(threadId));
    await context.driver;
    signal.throwIfAborted();
    return context;
  }

  private openContext(state: State, bundleId: string) {
    const context = state.contexts.get(bundleId);
    if (!context || !state.grants.has(bundleId))
      throw new Error(
        "Use desktop_open for this app before reading or acting on its windows.",
      );
    return context;
  }

  private async windows(
    context: Context,
    signal: AbortSignal,
    windowId?: number,
    expectedPid?: number,
  ): Promise<DesktopReply> {
    const pid = context.app.pid;
    if (!pid)
      throw new Error("The app is not running. Use desktop_open again.");
    const result = await (
      await context.driver
    ).call("list_windows", { pid }, signal);
    const data = desktopData(result);
    if (!Array.isArray(data.windows))
      throw new Error(
        "Cua returned an unreadable window list. No input was sent.",
      );
    if (
      windowId !== undefined &&
      !data.windows.some(
        (w: any) => w.window_id === windowId && w.pid === (expectedPid ?? pid),
      )
    )
      throw new Error(
        "Window closed or changed owner. Use desktop_open and take a new snapshot.",
      );
    return result;
  }

  private async snapshot(
    context: Context,
    windowId: number,
    includeImage: boolean,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    context.snapshots.clear();
    await this.windows(context, signal, windowId);
    const pid = context.app.pid!;
    const driver = await context.driver;
    const read = () =>
      driver.call(
        "get_window_state",
        {
          pid,
          window_id: windowId,
          include_screenshot: includeImage,
          max_elements: 250,
        },
        signal,
      );
    let result = await read();
    let data = desktopData(result);
    if (
      data.degraded &&
      /^(ax_window_unresolved|ax_app_launching)(:|$)/.test(
        data.degraded_reason ?? "",
      )
    ) {
      // A failed observation delivered no task input. Focus can safely recover an inaccessible window.
      await this.windows(context, signal, windowId, pid);
      desktopData(
        await driver.call(
          "bring_to_front",
          { pid, window_id: windowId },
          signal,
        ),
      );
      result = await read();
      data = desktopData(result);
    }
    const id = crypto.randomUUID();
    const visualOnly =
      !!data.degraded &&
      typeof data.degraded_reason === "string" &&
      data.degraded_reason.startsWith("ax_tree_empty:") &&
      data.escalation?.recommended === "px" &&
      typeof data.capture_id === "string" &&
      !!data.capture_id &&
      result.content.some(
        (part) => part.type === "image" && part.mimeType === "image/png",
      );
    const usable = !data.degraded || visualOnly;
    const nativeId = visualOnly ? undefined : data.snapshot_id;
    if (usable)
      context.snapshots.set(windowId, {
        id,
        pid,
        nativeId,
        captureId: data.capture_id,
        width: data.screenshot_width,
        height: data.screenshot_height,
      });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            app: context.app.bundleId,
            windowId,
            snapshotId: usable ? id : null,
            elementTokenPrefix:
              typeof nativeId === "string" ? `${nativeId}:` : undefined,
            degraded: !!data.degraded,
            visualOnly,
          }),
        },
        ...result.content,
      ],
      isError: !usable,
    };
  }

  private checkPoint(snapshot: Snapshot, x: number, y: number) {
    if (
      (snapshot.width && x >= snapshot.width) ||
      (snapshot.height && y >= snapshot.height)
    )
      throw new Error("Coordinates are outside the observed window.");
  }

  // Called synchronously at turn end/Stop to revoke admission before another chat can acquire the app.
  async finishTurn(threadId: string, revoke = false) {
    const state = this.states.get(threadId);
    if (!state) return;
    state.controller.abort();
    state.controller = new AbortController();
    const contexts = [...state.contexts.values()];
    state.contexts.clear();
    if (revoke) state.grants.clear();
    state.needsSetup = false;
    const previous = state.closing;
    state.closing = Promise.allSettled([
      previous,
      ...contexts.map(async (context) => {
        try {
          await (await context.driver).close();
        } finally {
          if (this.owners.get(context.app.bundleId)?.context === context)
            this.owners.delete(context.app.bundleId);
        }
      }),
    ]);
    this.notify(threadId, this.status(threadId));
    await state.closing;
  }

  async closeThread(threadId: string) {
    await this.finishTurn(threadId, true);
    this.states.delete(threadId);
  }

  async dispose() {
    await Promise.allSettled(
      [...this.states.keys()].map((id) => this.closeThread(id)),
    );
  }
}
