import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceAction, DeviceInfo } from "../shared/devices";
import { DEVICE_WORKER } from "./device-worker";
import { DEVICE_NOTICES } from "./device-notices";

export const DEVICE_VERSIONS = {
  "expo-device-hub": "0.15.3",
  "agent-device": "0.21.25",
} as const;
type Env = Record<string, string | undefined>;
export async function deviceRun(
  args: string[],
  env: Env,
  signal?: AbortSignal,
  timeoutMs = 15_000,
) {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  const abort = () => {
    if (child.exitCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (code !== 0)
      throw new Error(
        (stderr || stdout || `${args[0]} exited ${code}`).slice(-2000),
      );
    return stdout;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class DeviceRuntime {
  readonly env: Env;
  readonly sdk?: string;
  readonly adb?: string;
  readonly emulator?: string;
  private readOnlyEmulator: boolean;
  private installing?: Promise<void>;
  private starting?: Promise<void>;
  private hub?: ReturnType<typeof Bun.spawn>;
  private hubOrigin?: string;
  private hubToken?: string;
  private node?: string;
  private stopped = false;
  private booted = new Map<string, DeviceInfo>();
  private emulators = new Map<string, ReturnType<typeof Bun.spawn>>();
  private stopController = new AbortController();
  constructor(
    readonly directory: string,
    env: Env = process.env,
  ) {
    const inherited = Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) =>
          value !== undefined &&
          /^(HOME|PATH|SHELL|TMPDIR|LANG|LC_[A-Z_]+|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_AVD_HOME|ANDROID_USER_HOME|JAVA_HOME|DEVELOPER_DIR|SDKROOT|XDG_RUNTIME_DIR|DISPLAY|WAYLAND_DISPLAY|SERVE_EMU_FFMPEG|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/.test(
            key,
          ),
      ),
    );
    this.readOnlyEmulator = env.TACK_DEVICE_EMULATOR_READ_ONLY === "1";
    this.env = {
      ...inherited,
      DO_NOT_TRACK: "1",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      NO_COLOR: "1",
    };
    this.sdk =
      env.ANDROID_HOME ||
      env.ANDROID_SDK_ROOT ||
      [
        join(env.HOME ?? "", "Library/Android/sdk"),
        join(env.HOME ?? "", "Android/Sdk"),
      ].find(existsSync);
    this.adb =
      this.sdk && existsSync(join(this.sdk, "platform-tools/adb"))
        ? join(this.sdk, "platform-tools/adb")
        : (Bun.which("adb", { PATH: env.PATH }) ?? undefined);
    this.emulator =
      this.sdk && existsSync(join(this.sdk, "emulator/emulator"))
        ? join(this.sdk, "emulator/emulator")
        : (Bun.which("emulator", { PATH: env.PATH }) ?? undefined);
    if (this.sdk) {
      this.env.ANDROID_HOME = this.sdk;
      this.env.PATH = [
        join(this.sdk, "platform-tools"),
        join(this.sdk, "emulator"),
        env.PATH,
      ]
        .filter(Boolean)
        .join(":");
    }
  }
  private scope(signal?: AbortSignal) {
    return signal
      ? AbortSignal.any([signal, this.stopController.signal])
      : this.stopController.signal;
  }
  toolPath(name: keyof typeof DEVICE_VERSIONS) {
    return join(
      this.directory,
      "tools",
      name,
      DEVICE_VERSIONS[name],
      "node_modules",
      name,
    );
  }
  async inventory(
    signal?: AbortSignal,
  ): Promise<{
    devices: DeviceInfo[];
    available: boolean;
    warnings: string[];
  }> {
    const devices: DeviceInfo[] = [];
    const warnings: string[] = [];
    const scope = this.scope(signal);
    await Promise.all([
      (async () => {
        if (process.platform !== "darwin") return;
        try {
          const data = JSON.parse(
            await deviceRun(
              [
                "/usr/bin/xcrun",
                "simctl",
                "list",
                "devices",
                "available",
                "--json",
              ],
              this.env,
              scope,
            ),
          );
          for (const [runtime, rows] of Object.entries(data.devices ?? {}))
            for (const row of rows as any[])
              if (String(runtime).includes("iOS"))
                devices.push({
                  id: row.udid,
                  name: row.name,
                  platform: "ios",
                  booted: row.state === "Booted",
                  version: String(runtime)
                    .split("iOS-")[1]
                    ?.replaceAll("-", "."),
                });
        } catch (e) {
          warnings.push(String(e));
        }
      })(),
      (async () => {
        if (!this.adb || !this.emulator) return;
        try {
          const [avds, connected] = await Promise.all([
            deviceRun([this.emulator, "-list-avds"], this.env, scope),
            deviceRun([this.adb, "devices"], this.env, scope),
          ]);
          const running = new Map<string, string>();
          for (const line of connected.split("\n")) {
            const [serial, state] = line.trim().split(/\s+/);
            if (!serial?.startsWith("emulator-") || state !== "device")
              continue;
            try {
              const name = (
                await deviceRun(
                  [this.adb, "-s", serial, "emu", "avd", "name"],
                  this.env,
                  scope,
                  5000,
                )
              )
                .split(/\r?\n/)
                .find((s) => s && s !== "OK");
              if (name) running.set(name, serial);
            } catch {}
          }
          for (const name of avds
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean))
            devices.push({
              id: running.get(name) ?? name,
              name,
              platform: "android",
              booted: running.has(name),
              version: "Android",
            });
        } catch (e) {
          warnings.push(String(e));
        }
      })(),
    ]);
    scope.throwIfAborted();
    return { devices, available: devices.length > 0, warnings };
  }
  async ensure(signal?: AbortSignal) {
    const scope = this.scope(signal);
    scope.throwIfAborted();
    if (this.stopped) throw Error("Device runtime is stopped.");
    if (this.hub?.exitCode === null && this.hubOrigin && this.hubToken) return;
    this.node ??= Bun.which("node", { PATH: this.env.PATH }) ?? undefined;
    if (!this.node)
      throw Error("Device support needs Node.js 22.12 or later on this Mac.");
    const version = (
      await deviceRun(
        [this.node, "-p", "process.versions.node"],
        this.env,
        scope,
      )
    )
      .trim()
      .split(".")
      .map(Number);
    if ((version[0] ?? 0) < 22 || (version[0] === 22 && (version[1] ?? 0) < 12))
      throw Error("Device support needs Node.js 22.12 or later.");
    await (this.installing ??= this.install(scope).finally(() => {
      this.installing = undefined;
    }));
    scope.throwIfAborted();
    await (this.starting ??= this.startHub(scope).finally(() => {
      this.starting = undefined;
    }));
    scope.throwIfAborted();
  }
  private async install(signal: AbortSignal) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.directory, "THIRD_PARTY_NOTICES.txt"),
      DEVICE_NOTICES,
    );
    const npm = Bun.which("npm", { PATH: this.env.PATH });
    if (!npm)
      throw Error("Device support needs npm to prepare its native runtime.");
    for (const name of Object.keys(
      DEVICE_VERSIONS,
    ) as (keyof typeof DEVICE_VERSIONS)[]) {
      const version = DEVICE_VERSIONS[name],
        destination = dirname(dirname(this.toolPath(name)));
      const entry = join(
        this.toolPath(name),
        name === "agent-device" ? "dist/src/index.js" : "dist/server/cli.mjs",
      );
      if (
        existsSync(entry) &&
        existsSync(join(destination, ".install-complete"))
      )
        continue;
      mkdirSync(dirname(destination), { recursive: true });
      const staging = mkdtempSync(join(dirname(destination), ".install-"));
      try {
        await deviceRun(
          [
            npm,
            "install",
            "--prefix",
            staging,
            "--no-fund",
            "--no-audit",
            `${name}@${version}`,
          ],
          this.env,
          signal,
          600_000,
        );
        if (
          !existsSync(
            join(
              staging,
              "node_modules",
              name,
              name === "agent-device"
                ? "dist/src/index.js"
                : "dist/server/cli.mjs",
            ),
          )
        )
          throw Error(`Incomplete ${name} installation`);
        writeFileSync(join(staging, ".install-complete"), version);
        if (existsSync(destination))
          rmSync(destination, { recursive: true, force: true });
        renameSync(staging, destination);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  private async startHub(signal: AbortSignal) {
    if (this.hub?.exitCode === null && this.hubOrigin && this.hubToken) return;
    const socket = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = socket.port;
    socket.stop(true);
    const child = Bun.spawn(
      [
        this.node!,
        join(this.toolPath("expo-device-hub"), "dist/server/cli.mjs"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--require-token",
        "--hide-sidebar",
        "--hide-boot-device",
        ...(process.platform === "darwin" ? [] : ["--platform", "android"]),
      ],
      { env: this.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    this.hub = child;
    this.hubOrigin = undefined;
    this.hubToken = undefined;
    const origin = `http://127.0.0.1:${port}`;
    let stderr = "",
      stdout = "",
      token: string | undefined;
    // The pinned CLI creates its own token. Capture its startup link privately; never log or publish it.
    const tokenLine = new RegExp(
      `^\\s*Local:\\s+http://localhost:${port}/\\?token=([A-Za-z0-9_-]{43})\\s*$`,
    );
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        while (stdout.includes("\n")) {
          const i = stdout.indexOf("\n"),
            line = stdout.slice(0, i);
          stdout = stdout.slice(i + 1);
          const match = tokenLine.exec(line);
          if (match) token = match[1];
        }
        if (stdout.length > 8000) stdout = stdout.slice(-8000);
      }
    })().catch(() => {});
    void (async () => {
      for await (const chunk of child.stderr)
        stderr = (stderr + new TextDecoder().decode(chunk)).slice(-2000);
    })().catch(() => {});
    const until = Date.now() + 30_000;
    try {
      while (true) {
        signal.throwIfAborted();
        if (child.exitCode !== null)
          throw Error(
            (token ? stderr.replaceAll(token, "[redacted]") : stderr) ||
              "Device streaming runtime exited.",
          );
        try {
          const response = await fetch(origin + "/readyz", {
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          });
          if (response.ok && token) {
            this.hubOrigin = origin;
            this.hubToken = token;
            return;
          }
        } catch (e) {
          signal.throwIfAborted();
        }
        if (Date.now() > until)
          throw Error(
            "Device streaming runtime did not become ready with authentication.",
          );
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await child.exited;
      if (this.hub === child) {
        this.hub = undefined;
        this.hubOrigin = undefined;
        this.hubToken = undefined;
      }
      throw error;
    }
  }
  async hubRequest(path: string, signal?: AbortSignal, body?: unknown) {
    await this.ensure(signal);
    const scope = this.scope(signal);
    if (!this.hubOrigin || !this.hubToken)
      throw Error("Device runtime is stopped.");
    const response = await fetch(this.hubOrigin + path, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.hubToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: AbortSignal.any([scope, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok)
      throw Error(
        `Device runtime ${response.status}: ${(await response.text()).slice(0, 1000)}`,
      );
    return response;
  }
  async boot(device: DeviceInfo, signal?: AbortSignal) {
    const scope = this.scope(signal);
    if (device.booted) return device;
    if (device.platform === "ios") {
      await deviceRun(
        ["/usr/bin/xcrun", "simctl", "boot", device.id],
        this.env,
        scope,
        30_000,
      );
      this.booted.set(`ios:${device.id}`, device);
      try {
        await deviceRun(
          ["/usr/bin/xcrun", "simctl", "bootstatus", device.id, "-b"],
          this.env,
          scope,
          180_000,
        );
        return { ...device, booted: true };
      } catch (error) {
        try {
          await deviceRun(
            ["/usr/bin/xcrun", "simctl", "shutdown", device.id],
            this.env,
            undefined,
            10_000,
          );
        } catch {}
        this.booted.delete(`ios:${device.id}`);
        throw error;
      }
    }
    if (!this.emulator || !this.adb) throw Error("Android SDK is unavailable.");
    let port: number | undefined;
    for (let candidate = 5554; candidate <= 5680; candidate += 2) {
      try {
        const a = Bun.listen({
          hostname: "127.0.0.1",
          port: candidate,
          socket: { data() {} },
        });
        try {
          const b = Bun.listen({
            hostname: "127.0.0.1",
            port: candidate + 1,
            socket: { data() {} },
          });
          b.stop(true);
          port = candidate;
        } finally {
          a.stop(true);
        }
        if (port) break;
      } catch {}
    }
    if (!port) throw Error("No Android emulator port is available.");
    const child = Bun.spawn(
      [
        this.emulator,
        "-avd",
        device.name,
        "-port",
        String(port),
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot-save",
        ...(this.readOnlyEmulator ? ["-read-only"] : []),
      ],
      {
        env: this.env,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        detached: true,
      },
    );
    const running = { ...device, id: `emulator-${port}`, booted: true };
    this.emulators.set(running.id, child);
    this.booted.set(`android:${running.id}`, running);
    const until = Date.now() + 180_000;
    try {
      while (true) {
        scope.throwIfAborted();
        if (child.exitCode !== null)
          throw Error("Android emulator stopped during startup.");
        try {
          if (
            (
              await deviceRun(
                [
                  this.adb,
                  "-s",
                  running.id,
                  "shell",
                  "getprop",
                  "sys.boot_completed",
                ],
                this.env,
                scope,
                5000,
              )
            ).trim() === "1"
          )
            return running;
        } catch {
          scope.throwIfAborted();
        }
        if (Date.now() > until)
          throw Error("Android emulator did not finish starting.");
        await delay(500, undefined, { signal: scope });
      }
    } catch (error) {
      if (child.exitCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      await child.exited;
      this.emulators.delete(running.id);
      this.booted.delete(`android:${running.id}`);
      throw error;
    }
  }
  async attach(device: DeviceInfo, signal?: AbortSignal) {
    if (device.platform === "ios")
      await this.hubRequest("/vendor/serve-sim/grid/api/start", signal, {
        udid: device.id,
      });
  }
  async screenshot(device: DeviceInfo, signal?: AbortSignal) {
    const response = await this.hubRequest(
      `/vendor/${device.platform === "ios" ? "serve-sim" : "serve-emu"}/api/screenshot?device=${encodeURIComponent(device.id)}`,
      signal,
      {},
    );
    const png = Buffer.from(await response.arrayBuffer());
    if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG")
      throw Error("Device did not return a PNG screenshot.");
    return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }
  async ax(device: DeviceInfo, signal?: AbortSignal) {
    const path =
      device.platform === "ios"
        ? `/vendor/serve-sim/helper/${encodeURIComponent(device.id)}/ax`
        : `/vendor/serve-emu/api/accessibility?device=${encodeURIComponent(device.id)}`;
    return (await this.hubRequest(path, signal)).json();
  }
  async foreground(device: DeviceInfo, signal?: AbortSignal) {
    if (device.platform === "ios")
      return (
        await this.hubRequest(
          `/vendor/serve-sim/helper/${encodeURIComponent(device.id)}/foreground`,
          signal,
        )
      ).json();
    const text = await deviceRun(
      [this.adb!, "-s", device.id, "shell", "dumpsys", "window", "windows"],
      this.env,
      this.scope(signal),
    );
    const app = text.match(/mCurrentFocus=Window\{[^\n]+\s([\w.]+)\//)?.[1];
    return { bundleId: app };
  }
  async androidInput(
    device: DeviceInfo,
    action: DeviceAction,
    frame: { width: number; height: number },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.adb || device.platform !== "android")
      throw Error("Android input is unavailable.");
    const raw = await deviceRun(
      [this.adb, "-s", device.id, "shell", "wm", "size"],
      this.env,
      signal,
    );
    const dimensions = [
      ...raw.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g),
    ].at(-1);
    if (!dimensions) throw Error("Android screen size could not be verified.");
    let width = Number(dimensions[1]),
      height = Number(dimensions[2]);
    if (width > height !== frame.width > frame.height)
      [width, height] = [height, width];
    const x = (value: number) =>
      String(Math.round((value * width) / frame.width));
    const y = (value: number) =>
      String(Math.round((value * height) / frame.height));
    let input: string[];
    if (action.kind === "tap") input = ["tap", x(action.x), y(action.y)];
    else if (action.kind === "swipe")
      input = [
        "swipe",
        x(action.fromX),
        y(action.fromY),
        x(action.toX),
        y(action.toY),
        String(action.durationMs ?? 400),
      ];
    else if (action.kind === "key")
      input = [
        "keyevent",
        String(
          {
            home: 3,
            back: 4,
            recents: 187,
            enter: 66,
            delete: 67,
            escape: 111,
            tab: 61,
          }[action.key],
        ),
      ];
    else throw Error("Unsupported Android input action.");
    signal.throwIfAborted();
    // Drain this bounded native gesture through its release before Stop admits another action.
    await deviceRun(
      [this.adb, "-s", device.id, "shell", "input", ...input],
      this.env,
      undefined,
      10_000,
    );
    signal.throwIfAborted();
  }
  inputUrl(device: DeviceInfo) {
    if (!this.hubOrigin) throw Error("Device runtime is stopped.");
    return (
      this.hubOrigin.replace(/^http/, "ws") +
      (device.platform === "ios"
        ? `/vendor/serve-sim/helper/ws?device=${encodeURIComponent(device.id)}`
        : `/vendor/serve-emu/ws?device=${encodeURIComponent(device.id)}&frame-meta=1`)
    );
  }
  inputProtocols(device: DeviceInfo) {
    if (this.stopped || !this.hubToken)
      throw Error("Device runtime is stopped.");
    return [
      `${device.platform === "ios" ? "serve-sim" : "serve-emu"}.token.${this.hubToken}`,
    ];
  }
  createAgent(device: DeviceInfo) {
    return new DeviceAgent(
      this.node!,
      this.toolPath("agent-device"),
      join(this.directory, "sessions", crypto.randomUUID()),
      device,
      this.env,
    );
  }
  async shutdown(device: DeviceInfo, signal?: AbortSignal) {
    const key = `${device.platform}:${device.id}`;
    if (!this.booted.has(key))
      throw Error(
        "Tack will not shut down a device that was already running before this chat.",
      );
    if (device.platform === "ios")
      await deviceRun(
        ["/usr/bin/xcrun", "simctl", "shutdown", device.id],
        this.env,
        this.scope(signal),
        30_000,
      );
    else if (this.adb)
      await deviceRun(
        [this.adb, "-s", device.id, "emu", "kill"],
        this.env,
        this.scope(signal),
        10_000,
      );
    const child = this.emulators.get(device.id);
    if (child) {
      try {
        child.kill();
      } catch {}
      await child.exited;
      this.emulators.delete(device.id);
    }
    this.booted.delete(key);
  }
  async dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    await Promise.allSettled([this.installing, this.starting]);
    const hub = this.hub;
    this.hub = undefined;
    this.hubOrigin = undefined;
    this.hubToken = undefined;
    if (hub) {
      try {
        hub.kill("SIGTERM");
      } catch {}
      await Promise.race([hub.exited, delay(1500)]);
      if (hub.exitCode === null)
        try {
          hub.kill("SIGKILL");
        } catch {}
      await hub.exited;
    }
    // Only devices booted by this runtime are retired. Pre-existing devices are left alone.
    for (const device of this.booted.values())
      try {
        if (device.platform === "ios")
          await deviceRun(
            ["/usr/bin/xcrun", "simctl", "shutdown", device.id],
            this.env,
            undefined,
            10_000,
          );
        else if (this.adb)
          await deviceRun(
            [this.adb, "-s", device.id, "emu", "kill"],
            this.env,
            undefined,
            5000,
          );
      } catch {}
    for (const child of this.emulators.values()) {
      if (child.exitCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      await child.exited;
    }
    this.emulators.clear();
    this.booted.clear();
  }
}

export class DeviceAgent {
  private child: ReturnType<typeof Bun.spawn>;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void }
  >();
  private next = 0;
  private ready: Promise<void>;
  private stderr = "";
  private closing?: Promise<void>;
  private retireDaemon: () => Promise<void>;
  constructor(
    node: string,
    tool: string,
    readonly directory: string,
    device: DeviceInfo,
    env: Env,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, "worker.mjs");
    writeFileSync(script, DEVICE_WORKER);
    const config = {
      entry: join(tool, "dist/src/index.js"),
      cli: join(tool, "bin/agent-device.mjs"),
      stateDir: directory,
      session: "tack-" + crypto.randomUUID(),
      target: {
        platform: device.platform,
        ...(device.platform === "ios"
          ? { udid: device.id }
          : { serial: device.id }),
      },
    };
    const child = Bun.spawn([node, script, JSON.stringify(config)], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    this.retireDaemon = async () => {
      await deviceRun(
        [
          node,
          join(tool, "bin/agent-device.mjs"),
          "daemon",
          "stop",
          "--state-dir",
          directory,
        ],
        env,
        undefined,
        8000,
      );
    };
    let readyResolve: () => void, readyReject: (e: Error) => void;
    this.ready = new Promise((r, j) => {
      readyResolve = r;
      readyReject = j;
    });
    void this.ready.catch(() => {});
    const readyTimer = setTimeout(() => {
      readyReject!(Error("Device agent runtime did not initialize in time."));
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 15_000);
    void this.ready.then(
      () => clearTimeout(readyTimer),
      () => clearTimeout(readyTimer),
    );
    void (async () => {
      for await (const c of child.stderr)
        this.stderr = (this.stderr + new TextDecoder().decode(c)).slice(-2000);
    })().catch(() => {});
    void (async () => {
      let buffer = "";
      for await (const c of child.stdout) {
        buffer += new TextDecoder().decode(c);
        while (buffer.includes("\n")) {
          const i = buffer.indexOf("\n"),
            line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          let q: any;
          try {
            q = JSON.parse(line);
          } catch {
            continue;
          }
          if (q.ready) {
            readyResolve!();
            continue;
          }
          const p = this.pending.get(q.id);
          if (p) {
            this.pending.delete(q.id);
            q.error
              ? p.reject(
                  Object.assign(
                    Error(q.error.message ?? "Device command failed"),
                    { details: q.error },
                  ),
                )
              : p.resolve(q.result);
          }
        }
      }
    })().catch((e) => readyReject!(e));
    this.child.exited.then(() => {
      const error = Error(this.stderr || "Device agent runtime stopped.");
      readyReject!(error);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
  }
  private send(message: unknown) {
    const stdin = this.child.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(message) + "\n");
    stdin.flush();
  }
  async call(
    method: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    signal?.throwIfAborted();
    if (this.closing) throw Error("Device session is closed.");
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(Error("Device command canceled before startup."));
      signal?.addEventListener("abort", abort, { once: true });
      this.ready.then(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
    signal?.throwIfAborted();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => {
        try {
          this.send({ cancel: id });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      };
      const finish = (callback: (v: any) => void) => (value: any) => {
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish(reject),
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ id, method, input });
    });
  }
  close() {
    return (this.closing ??= (async () => {
      try {
        this.send({ id: ++this.next, method: "close" });
        (this.child.stdin as import("bun").FileSink).end();
      } catch {}
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }, 12_000);
      try {
        await this.child.exited;
        await this.retireDaemon();
        rmSync(this.directory, { recursive: true, force: true });
      } finally {
        clearTimeout(timer);
      }
    })());
  }
}
