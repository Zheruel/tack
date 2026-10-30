// Branch, uncommitted changes and the open PR for a project, plus fast file lookup for @-mentions.

import type { GitInfo, PullRequest } from "../shared/protocol";

const FILES_TTL_MS = 3_000; // long enough to cover one burst of typing

export class Git {
  private files = new Map<string, { at: number; list: Promise<string[]> }>();

  constructor(private env: Record<string, string>) {}

  async info(cwd: string): Promise<GitInfo> {
    const [branch, stat, untracked] = await Promise.all([
      this.run(cwd, ["git", "branch", "--show-current"]),
      this.run(cwd, ["git", "diff", "HEAD", "--numstat"]),
      this.run(cwd, ["git", "ls-files", "--others", "--exclude-standard"]),
    ]);
    if (branch === undefined) return { branch: null, changes: { files: 0, additions: 0, deletions: 0 }, pr: null };
    const changes = { files: 0, additions: 0, deletions: 0 };
    for (const line of (stat ?? "").split("\n")) {
      const [a, d] = line.split("\t");
      if (a === undefined || d === undefined) continue;
      changes.files++;
      changes.additions += Number(a) || 0;
      changes.deletions += Number(d) || 0;
    }
    changes.files += (untracked ?? "").split("\n").filter(Boolean).length;
    return { branch: branch.trim() || null, changes, pr: branch.trim() ? await this.pr(cwd) : null };
  }

  // Fuzzy path match over tracked + untracked files: every query character in order,
  // scored toward matches in the file name and contiguous runs.
  async search(cwd: string, query: string): Promise<string[]> {
    const all = await this.list(cwd);
    const q = query.toLowerCase();
    if (!q) return all.slice(0, 30);
    const scored: [number, string][] = [];
    for (const path of all) {
      const s = score(path.toLowerCase(), q);
      if (s > 0) scored.push([s, path]);
    }
    return scored
      .sort((a, b) => b[0] - a[0] || a[1].length - b[1].length)
      .slice(0, 30)
      .map(([, p]) => p);
  }

  private list(cwd: string): Promise<string[]> {
    const hit = this.files.get(cwd);
    if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.list;
    const list = this.run(cwd, ["git", "ls-files", "--cached", "--others", "--exclude-standard"]).then((out) =>
      (out ?? "").split("\n").filter(Boolean),
    );
    this.files.set(cwd, { at: Date.now(), list });
    return list;
  }

  private async pr(cwd: string): Promise<PullRequest | null> {
    const out = await this.run(cwd, [
      "gh",
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,additions,deletions,statusCheckRollup",
    ]);
    if (!out) return null;
    try {
      const p = JSON.parse(out);
      return {
        number: p.number,
        title: p.title,
        url: p.url,
        state: p.state,
        draft: p.isDraft,
        additions: p.additions,
        deletions: p.deletions,
        checks: rollup(p.statusCheckRollup ?? []),
      };
    } catch {
      return null;
    }
  }

  private async run(cwd: string, cmd: string[]): Promise<string | undefined> {
    try {
      const proc = Bun.spawn(cmd, { cwd, env: this.env, stdout: "pipe", stderr: "ignore" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }
}

function rollup(checks: any[]): PullRequest["checks"] {
  if (!checks.length) return null;
  const states = checks.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", ""].includes(s))) return "pending";
  return "pass";
}

function score(path: string, q: string): number {
  const nameStart = path.lastIndexOf("/") + 1;
  let s = 0;
  let pi = 0;
  let run = 0;
  for (const ch of q) {
    const at = path.indexOf(ch, pi);
    if (at < 0) return 0;
    run = at === pi ? run + 1 : 1;
    s += run * 2 + (at >= nameStart ? 3 : 0) + (at === nameStart ? 5 : 0);
    pi = at + 1;
  }
  return s;
}
