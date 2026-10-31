import {
  ArrowLeft,
  ArrowRight,
  Home,
  Loader2,
  Maximize2,
  Minimize2,
  Power,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DeviceAction,
  DevicePlatform,
  DevicePreview,
} from "../../../shared/devices";
import type { Requests } from "../../../shared/protocol";
import { call, onConnect, onEvent } from "../rpc";

type Command = Requests["device.command"]["params"];
type Frame = {
  deviceId: string;
  snapshotId?: string;
  image: string;
  width: number;
  height: number;
};
type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  started: number;
  frame: Frame;
};
const KEYS: Record<string, Extract<DeviceAction, { kind: "key" }>["key"]> = {
  Enter: "enter",
  Home: "home",
  Escape: "escape",
  Backspace: "delete",
  Delete: "delete",
};

export function DevicePane({
  threadId,
  onClose,
}: {
  threadId: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<DevicePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const latest = useRef<DevicePreview | undefined>(undefined);
  const picture = useRef<HTMLImageElement>(null);
  const frame = useRef<Frame | undefined>(undefined);
  const gesture = useRef<Gesture | undefined>(undefined);
  const generation = useRef(0);
  const revision = useRef(0);
  const pending = useRef(0);
  const activity = useRef({ generation: 0, count: 0 });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const lastFrame = useRef(0);

  const update = (value: DevicePreview) => {
    if (
      value.image &&
      (value.image !== latest.current?.image ||
        value.snapshotId !== latest.current?.snapshotId)
    )
      lastFrame.current = Date.now();
    latest.current = value;
    setPreview(value);
  };

  // Polling, navigation and input share one queue. Queued work is discarded when its chat changes.
  const enqueue = (request: () => Promise<DevicePreview>, quiet = false) => {
    const owner = generation.current;
    pending.current++;
    if (!quiet) {
      activity.current.count++;
      setBusy(true);
      setError("");
    }
    const run = queue.current
      .catch(() => {})
      .then(async () => {
        if (owner !== generation.current) return;
        const started = revision.current;
        try {
          const value = await request();
          if (owner === generation.current && started === revision.current) {
            update(value);
            setError(value.error ?? "");
          }
          return value;
        } catch (e) {
          if (owner === generation.current)
            setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        pending.current--;
        if (!quiet && owner === activity.current.generation) {
          activity.current.count--;
          if (owner === generation.current) setBusy(activity.current.count > 0);
        }
      });
    queue.current = run;
    return run;
  };

  const command = (
    name: Command["name"],
    input: Command["input"] = {},
    quiet = false,
  ) => enqueue(() => call("device.command", { threadId, name, input }), quiet);

  useEffect(() => {
    const owner = ++generation.current;
    activity.current = { generation: owner, count: 0 };
    latest.current = undefined;
    frame.current = undefined;
    gesture.current = undefined;
    lastFrame.current = 0;
    revision.current++;
    setPreview(undefined);
    setBusy(false);
    setError("");
    setText("");
    let visible = true;
    let timer: ReturnType<typeof setTimeout>;
    const active = () => owner === generation.current;
    const load = async () => {
      const value = await enqueue(() => call("device.get", { threadId }), true);
      if (active() && value && !value.devices.length)
        void command("device_list", {}, true);
    };
    const poll = async () => {
      const value = latest.current;
      if (!active()) return;
      if (
        visible &&
        !document.hidden &&
        !pending.current &&
        !gesture.current &&
        value?.currentDeviceId &&
        value.status === "ready" &&
        Date.now() - lastFrame.current >= 1_000
      ) {
        await command(
          "device_snapshot",
          {
            deviceId: value.currentDeviceId,
            includeTree: false,
            displayOnly: true,
          },
          true,
        );
      }
      if (active()) timer = setTimeout(poll, 1_000);
    };
    const off = onEvent((event) => {
      if (!active() || event.type !== "device" || event.threadId !== threadId)
        return;
      revision.current++;
      update(event.preview);
      setError(event.preview.error ?? "");
    });
    const disconnect = onConnect(() => {
      if (active()) void load();
    });
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
    });
    if (pane.current) observer.observe(pane.current);
    void load();
    timer = setTimeout(poll, 1_000);
    return () => {
      generation.current++;
      clearTimeout(timer);
      observer.disconnect();
      off();
      disconnect();
      gesture.current = undefined;
    };
  }, [threadId]);

  const current = preview?.open.find(
    (device) => device.id === preview.currentDeviceId,
  );
  const blocked = busy || preview?.status === "starting";
  const open = (platform: DevicePlatform) => {
    const existing = latest.current?.open.find(
      (device) => device.platform === platform,
    );
    void command("device_open", {
      platform,
      ...(existing ? { deviceId: existing.id } : {}),
    });
  };

  const act = (action: DeviceAction, observed?: Frame) => {
    const deviceId = observed?.deviceId ?? latest.current?.currentDeviceId;
    if (!deviceId) return Promise.resolve(undefined);
    return enqueue(() => {
      const value = latest.current;
      if (value?.currentDeviceId !== deviceId)
        throw new Error("The active device changed. Use its current screen.");
      if (
        observed &&
        (value.image !== observed.image ||
          (value.width !== undefined && value.width !== observed.width) ||
          (value.height !== undefined && value.height !== observed.height))
      )
        throw new Error(
          "The screen changed during that gesture. Try again on the current screen.",
        );
      return call("device.command", {
        threadId,
        name: "device_act",
        input: { deviceId, snapshotId: value.snapshotId, action },
      });
    });
  };

  const point = (
    clientX: number,
    clientY: number,
    observed: Frame,
    clamp = false,
  ) => {
    const rect = picture.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const scale = Math.min(
      rect.width / observed.width,
      rect.height / observed.height,
    );
    const x =
      (clientX - rect.left - (rect.width - observed.width * scale) / 2) / scale;
    const y =
      (clientY - rect.top - (rect.height - observed.height * scale) / 2) /
      scale;
    if (
      !clamp &&
      (x < 0 || y < 0 || x >= observed.width || y >= observed.height)
    )
      return;
    return {
      x: Math.max(0, Math.min(observed.width - 1, Math.round(x))),
      y: Math.max(0, Math.min(observed.height - 1, Math.round(y))),
    };
  };

  return (
    <aside
      ref={pane}
      className="browser-pane"
      style={{ flexBasis: 460 }}
      data-expanded={expanded || undefined}
      aria-label="Mobile device"
    >
      <div className="browser-tabbar" data-tauri-drag-region>
        <Smartphone size={15} className="shrink-0 text-dim" />
        <span
          className="min-w-0 truncate px-1 text-[12px] text-ink"
          title={current?.name}
        >
          {current?.name ?? "Mobile preview"}
        </span>
        <div className="browser-window-actions">
          <IconButton
            label="Refresh device"
            disabled={blocked}
            onClick={() =>
              void command(
                current ? "device_snapshot" : "device_list",
                current
                  ? {
                      deviceId: current.id,
                      includeTree: false,
                      displayOnly: true,
                    }
                  : {},
              )
            }
          >
            <RefreshCw size={14} />
          </IconButton>
          <IconButton
            label="Close device"
            disabled={!current || blocked}
            onClick={() =>
              void command("device_close", { deviceId: current?.id })
            }
          >
            <Power size={14} />
          </IconButton>
          <IconButton
            label={expanded ? "Restore device pane" : "Expand device pane"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          <IconButton label="Hide device pane" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </div>

      <div className="browser-navigation">
        {(["ios", "android"] as const).map((platform) => (
          <button
            key={platform}
            type="button"
            disabled={blocked || !preview?.available}
            aria-pressed={current?.platform === platform}
            onClick={() => open(platform)}
            className={`rounded-md px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 ${current?.platform === platform ? "bg-brass/10 text-brass" : "text-dim hover:bg-hover hover:text-ink"}`}
          >
            {platform === "ios" ? "iOS" : "Android"}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {current?.platform === "android" && (
            <IconButton
              label="Device back"
              disabled={blocked}
              onClick={() => void act({ kind: "key", key: "back" })}
            >
              <ArrowLeft size={15} />
            </IconButton>
          )}
          <IconButton
            label="Device home"
            disabled={!current || blocked}
            onClick={() => void act({ kind: "key", key: "home" })}
          >
            <Home size={15} />
          </IconButton>
        </div>
      </div>

      {error && (
        <div className="browser-error" role="alert">
          <span>{error}</span>
          <button
            onClick={() => setError("")}
            aria-label="Dismiss device error"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div
        className="browser-stage"
        style={{ overflow: "hidden" }}
        aria-busy={blocked}
      >
        {blocked && <div className="browser-progress" />}
        {preview?.image && current ? (
          <div className="flex h-full min-h-0 items-center justify-center p-4">
            <img
              ref={picture}
              src={preview.image}
              alt={`${current.name} screen. Tap or drag to interact.`}
              draggable={false}
              tabIndex={0}
              role="application"
              className="h-full w-full select-none rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-brass"
              style={{
                objectFit: "contain",
                touchAction: "none",
                cursor: blocked ? "wait" : "crosshair",
              }}
              onLoad={(e) => {
                const value = latest.current;
                const width = value?.width ?? e.currentTarget.naturalWidth;
                const height = value?.height ?? e.currentTarget.naturalHeight;
                if (
                  value?.image &&
                  value.currentDeviceId &&
                  width > 0 &&
                  height > 0 &&
                  e.currentTarget.currentSrc === value.image
                )
                  frame.current = {
                    deviceId: value.currentDeviceId,
                    snapshotId: value.snapshotId,
                    image: value.image,
                    width,
                    height,
                  };
              }}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (
                  e.button !== 0 ||
                  blocked ||
                  activity.current.count ||
                  !frame.current
                )
                  return;
                const observed = frame.current;
                const from = point(e.clientX, e.clientY, observed);
                if (!from) return;
                e.preventDefault();
                e.currentTarget.focus({ preventScroll: true });
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = {
                  pointerId: e.pointerId,
                  ...from,
                  clientX: e.clientX,
                  clientY: e.clientY,
                  started: performance.now(),
                  frame: observed,
                };
              }}
              onPointerUp={(e) => {
                const start = gesture.current;
                if (!start || start.pointerId !== e.pointerId) return;
                gesture.current = undefined;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
                const to = point(e.clientX, e.clientY, start.frame, true);
                if (!to) return;
                const swipe =
                  Math.hypot(
                    e.clientX - start.clientX,
                    e.clientY - start.clientY,
                  ) > 8;
                void act(
                  swipe
                    ? {
                        kind: "swipe",
                        fromX: start.x,
                        fromY: start.y,
                        toX: to.x,
                        toY: to.y,
                        durationMs: Math.max(
                          100,
                          Math.min(
                            2_000,
                            Math.round(performance.now() - start.started),
                          ),
                        ),
                      }
                    : { kind: "tap", x: start.x, y: start.y },
                  start.frame,
                );
              }}
              onPointerCancel={() => {
                gesture.current = undefined;
              }}
              onLostPointerCapture={() => {
                gesture.current = undefined;
              }}
              onKeyDown={(e) => {
                if (
                  blocked ||
                  e.ctrlKey ||
                  e.metaKey ||
                  e.altKey ||
                  e.nativeEvent.isComposing
                )
                  return;
                const key = KEYS[e.key];
                if (!key) return;
                e.preventDefault();
                e.stopPropagation();
                void act({ kind: "key", key });
              }}
            />
          </div>
        ) : (
          <div className="browser-empty">
            <div className="browser-globe-mark">
              {blocked || !preview ? (
                <Loader2 size={25} className="browser-spin" />
              ) : (
                <Smartphone size={25} strokeWidth={1.3} />
              )}
            </div>
            <h2>
              {blocked
                ? "Starting your device…"
                : !preview
                  ? "Checking devices…"
                  : "Mobile preview"}
            </h2>
            <p>
              {preview && !preview.available
                ? "No mobile emulators are available on this Mac."
                : "Open a device here or ask your agent to run your app."}
            </p>
            {preview?.available && !blocked && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="browser-primary"
                  onClick={() => open("ios")}
                >
                  Open iOS
                </button>
                <button
                  type="button"
                  className="browser-primary"
                  onClick={() => open("android")}
                >
                  Open Android
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {current && (
        <form
          className="browser-navigation"
          onSubmit={(e) => {
            e.preventDefault();
            if (blocked || !text) return;
            const value = text;
            const owner = generation.current;
            void act({ kind: "type", text: value }).then((result) => {
              if (
                result &&
                !result.error &&
                result.status !== "error" &&
                owner === generation.current
              )
                setText((current) => (current === value ? "" : current));
            });
          }}
        >
          <div className="browser-address">
            <input
              aria-label="Type on device"
              placeholder="Type on device…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={blocked}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="browser-go"
              aria-label="Send text to device"
              disabled={blocked || !text}
            >
              <ArrowRight size={14} />
            </button>
          </div>
          <IconButton
            label="Device enter"
            disabled={blocked}
            onClick={() => void act({ kind: "key", key: "enter" })}
          >
            <span className="text-[15px]">↵</span>
          </IconButton>
        </form>
      )}
    </aside>
  );
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="browser-icon"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
