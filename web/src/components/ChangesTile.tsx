import { GitMerge, GitPullRequest, GitPullRequestDraft } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitInfo, PullRequest } from "../../../shared/protocol";
import { openExternal } from "../native";
import { call } from "../rpc";
import { useApp } from "../store";

const REFRESH_MS = 30_000;

// The branch's PR as a small tile in the thread header, like Claude's desktop app. Click to open it.
export function ChangesTile({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId])!;
  const git = useGit(thread.projectId, thread.status);
  return git?.pr ? <PrTile pr={git.pr} /> : null;
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
      title={`${state.label}: ${pr.title}. Click to open #${pr.number} in your browser${checks ? `. ${checks.label}` : ""}`}
      className="dock-in flex h-7 max-w-[340px] min-w-0 items-center gap-2 rounded-lg border border-line/80 px-2.5 text-[12.5px] transition-colors hover:border-[#4a423a] hover:bg-raised/60"
    >
      <state.icon size={13} className={`shrink-0 ${state.color}`} />
      <span className="min-w-0 truncate text-ink/90">{pr.title}</span>
      <span className="shrink-0 font-mono text-[11.5px] text-faint tabular-nums">#{pr.number}</span>
      <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
        <span className="text-ok">+{pr.additions.toLocaleString()}</span> <span className="text-danger/90">−{pr.deletions.toLocaleString()}</span>
      </span>
      {checks && <span className={`size-1.5 shrink-0 rounded-full ${checks.dot}`} />}
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
