import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentWorkspace } from "./agent-types";

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
  const stop = () => {
    // Checkout can start subprocesses; cancellation must stop them before cleanup.
    try { globalThis.process.kill(-process.pid, "SIGKILL"); } catch { process.kill("SIGKILL"); }
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) stop();
    const [code, output, errors] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(errors.trim() || output.trim() || `git ${args[0]} failed (${code}).`);
    return output.trim();
  } finally { signal?.removeEventListener("abort", stop); }
}

export async function prepareAgentWorkspace(
  projectPath: string,
  childId: string,
  isolation: "shared" | "worktree",
  signal?: AbortSignal,
  workspaceRoot = join(process.env.TACK_DATA_DIR ?? join(homedir(), "Library", "Application Support", "dev.tack.app"), "agent-worktrees"),
): Promise<AgentWorkspace> {
  signal?.throwIfAborted();
  if (isolation === "shared") return { kind: "shared", path: projectPath };
  const commit = await git(projectPath, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  signal?.throwIfAborted();
  const root = resolve(workspaceRoot);
  mkdirSync(root, { recursive: true });
  const slug = childId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "child";
  // A new private directory reserves this call's path; existing worktrees are never reused.
  const path = mkdtempSync(join(root, `${slug}-`));
  const branch = `codex/agent-${basename(path)}`;
  let branchCreated = false;
  try {
    // This short reservation is not interrupted halfway through creating its ref.
    await git(projectPath, ["branch", "--", branch, commit]);
    branchCreated = true;
    signal?.throwIfAborted();
    await git(projectPath, ["worktree", "add", "--", path, branch], signal);
    signal?.throwIfAborted();
    return { kind: "worktree", path, branch };
  } catch (error) {
    if (branchCreated) {
      // Both the path and branch were created by this call. Double force also handles
      // a cancelled checkout's temporary lock, without pruning any other worktree.
      await git(projectPath, ["worktree", "remove", "--force", "--force", "--", path]).catch(() => {});
    }
    rmSync(path, { recursive: true, force: true });
    if (branchCreated) await git(projectPath, ["branch", "-D", "--", branch]).catch(() => {});
    throw error;
  }
}
