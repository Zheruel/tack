// Watches the installed claude and codex CLIs for newer releases and runs their own updaters.

import type { CliName, CliStatus } from "../shared/protocol";

const PACKAGES: Record<CliName, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
const CHECK_EVERY_MS = 3 * 60 * 60_000;

export class Updates {
  status: Record<CliName, CliStatus> = {
    claude: { name: "claude", state: "missing" },
    codex: { name: "codex", state: "missing" },
  };

  constructor(
    private paths: Partial<Record<CliName, string>>,
    private env: Record<string, string>,
    private emit: (status: CliStatus) => void,
    private updated: (name: CliName) => void,
  ) {
    this.check();
    setInterval(() => this.check(), CHECK_EVERY_MS).unref();
  }

  async check() {
    await Promise.all((Object.keys(PACKAGES) as CliName[]).map((name) => this.checkOne(name)));
  }

  async update(name: CliName) {
    const bin = this.paths[name];
    const current = this.status[name];
    if (!bin || current.state === "updating") return;
    this.set({ ...current, state: "updating", error: undefined });
    const proc = Bun.spawn([bin, "update"], { env: this.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const last = (err || out).trim().split("\n").pop() || `exited with code ${code}`;
      this.set({ ...this.status[name], state: "available", error: last });
      return;
    }
    await this.checkOne(name);
    if (this.status[name].state === "current") this.updated(name);
  }

  private async checkOne(name: CliName) {
    const bin = this.paths[name];
    if (!bin) return this.set({ name, state: "missing" });
    const [installed, latest] = await Promise.all([this.installedVersion(bin), this.latestVersion(name)]);
    if (!installed) return this.set({ name, state: "missing" });
    const state = latest && newer(latest, installed) ? "available" : "current";
    this.set({ name, state, installed, latest: latest ?? installed });
  }

  private async installedVersion(bin: string): Promise<string | undefined> {
    try {
      const proc = Bun.spawn([bin, "--version"], { env: this.env, stdout: "pipe", stderr: "ignore" });
      return (await new Response(proc.stdout).text()).match(/\d+\.\d+\.\d+/)?.[0];
    } catch {
      return undefined;
    }
  }

  private async latestVersion(name: CliName): Promise<string | undefined> {
    try {
      const res = await fetch(`https://registry.npmjs.org/${PACKAGES[name]}/latest`, { signal: AbortSignal.timeout(8000) });
      return ((await res.json()) as { version?: string }).version;
    } catch {
      return undefined; // offline: say nothing rather than guess
    }
  }

  private set(status: CliStatus) {
    this.status[status.name] = status;
    this.emit(status);
  }
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
