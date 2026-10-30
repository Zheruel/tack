import { ArrowUpRight, GitBranch, GitMerge, GitPullRequest, GitPullRequestDraft } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitInfo, PullRequest } from "../../../shared/protocol";
import { openExternal } from "../native";
import { call } from "../rpc";
import { useApp } from "../store";

const REFRESH_MS = 30_000;

// Where the thread's work lives: the branch's PR as one tile, like Claude Code.
export function Panel({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId])!;
  const git = useGit(thread.projectId, thread.status);

  return (
    <aside className="w-[264px] shrink-0 border-l border-line/70 bg-canvas px-3 pt-[54px]">
      <h2 className="px-1 pb-2 text-[11.5px] font-medium text-faint">Changes</h2>
      {git === undefined ? (
        <div className="h-[58px] animate-pulse rounded-xl bg-raised/60" />
      ) : git.pr ? (
        <PrTile pr={git.pr} />
      ) : (
        <div className="rounded-xl border border-line/80 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12.5px] text-dim">
            <GitBranch size={13} className="shrink-0 text-faint" />
            <span className="truncate font-mono text-[12px]">{git.branch ?? "Not a git repository"}</span>
          </div>
          {git.branch && (
            <p className="mt-1 pl-[21px] text-[12px] text-faint">
              {git.changes.files ? `${git.changes.files} uncommitted, no PR yet` : "No pull request"}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

const STATE = {
  OPEN: { icon: GitPullRequest, color: "text-ok", label: "Open" },
  DRAFT: { icon: GitPullRequestDraft, color: "text-dim", label: "Draft" },
  MERGED: { icon: GitMerge, color: "text-[#b59ce0]", label: "Merged" },
  CLOSED: { icon: GitPullRequest, color: "text-danger/90", label: "Closed" },
};

const CHECKS = {
  pass: { dot: "bg-ok", label: "Checks passing" },
  fail: { dot: "bg-danger", label: "Checks failing" },
  pending: { dot: "bg-brass pulse", label: "Checks running" },
};

function PrTile({ pr }: { pr: PullRequest }) {
  const state = STATE[pr.draft && pr.state === "OPEN" ? "DRAFT" : pr.state];
  const checks = pr.checks && CHECKS[pr.checks];
  return (
    <button
      onClick={() => openExternal(pr.url)}
      title={`${state.label}. Open #${pr.number} in your browser`}
      className="group w-full rounded-xl border border-line/80 px-3 py-2.5 text-left transition-colors hover:border-[#4a423a] hover:bg-raised/60"
    >
      <div className="flex items-center gap-2">
        <state.icon size={14} className={`shrink-0 ${state.color}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{pr.title}</span>
        <ArrowUpRight size={13} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[22px] font-mono text-[11.5px] tabular-nums">
        <span className="text-faint">#{pr.number}</span>
        <span className="text-ok">+{pr.additions.toLocaleString()}</span>
        <span className="-ml-1 text-danger/90">−{pr.deletions.toLocaleString()}</span>
        {checks && <span title={checks.label} className={`ml-auto size-1.5 rounded-full ${checks.dot}`} />}
      </div>
    </button>
  );
}

// Refetch when the project changes, when a turn ends (work may have been committed or pushed),
// and every so often while the window is in front.
function useGit(projectId: string, status: string): GitInfo | undefined {
  const [info, setInfo] = useState<{ projectId: string; git: GitInfo }>();
  useEffect(() => {
    if (status === "running") return;
    let live = true;
    const load = () => call("git.info", { projectId }).then((git) => live && setInfo({ projectId, git }));
    load();
    const timer = setInterval(() => document.hasFocus() && load(), REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [projectId, status]);
  return info?.projectId === projectId ? info.git : undefined;
}
