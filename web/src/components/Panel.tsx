import { ArrowUpRight, GitBranch, GitPullRequest, GitPullRequestDraft, GitMerge } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitInfo, PullRequest } from "../../../shared/protocol";
import { openExternal } from "../native";
import { call } from "../rpc";
import { useApp } from "../store";
import { ProviderMark, tokens } from "./Composer";

const REFRESH_MS = 30_000;

// The thread's surroundings: where its work lives (branch, PR) and how full its context is.
export function Panel({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.threads[threadId])!;
  const model = useApp((s) => s.models.find((m) => m.value === thread.model));
  const git = useGit(thread.projectId, thread.status);

  return (
    <aside className="flex w-[288px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line/70 bg-canvas px-4 pt-[58px] pb-5">
      <Section title="Branch">
        {git === undefined ? (
          <Skeleton />
        ) : git.branch === null ? (
          <p className="text-[12.5px] text-faint">Not a git repository</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <GitBranch size={14} className="shrink-0 text-faint" />
              <span className="truncate font-mono text-[12.5px]">{git.branch}</span>
            </div>
            <p className="mt-1.5 pl-[22px] text-[12px] text-faint">
              {git.changes.files ? (
                <>
                  {git.changes.files} uncommitted {git.changes.files === 1 ? "file" : "files"}{" "}
                  {git.changes.additions + git.changes.deletions > 0 && (
                    <Diffstat add={git.changes.additions} del={git.changes.deletions} />
                  )}
                </>
              ) : (
                "Working tree clean"
              )}
            </p>
          </>
        )}
      </Section>

      {git?.branch && (
        <Section title="Pull request">{git.pr ? <PrCard pr={git.pr} /> : <p className="text-[12.5px] text-faint">None for this branch yet</p>}</Section>
      )}

      <Section title="Context">
        <ContextMeter context={thread.context} />
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-faint">
          <ProviderMark provider={thread.provider} />
          {model?.label ?? thread.model}
        </p>
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[11.5px] font-medium text-faint">{title}</h2>
      {children}
    </section>
  );
}

function Skeleton() {
  return <div className="h-4 w-32 animate-pulse rounded bg-hover" />;
}

function Diffstat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono text-[11.5px] tabular-nums">
      <span className="text-ok">+{add}</span> <span className="text-danger/90">−{del}</span>
    </span>
  );
}

const PR_STATE = {
  OPEN: { icon: GitPullRequest, label: "Open", color: "text-ok" },
  DRAFT: { icon: GitPullRequestDraft, label: "Draft", color: "text-dim" },
  MERGED: { icon: GitMerge, label: "Merged", color: "text-[#b59ce0]" },
  CLOSED: { icon: GitPullRequest, label: "Closed", color: "text-danger/90" },
};

const CHECKS = {
  pass: { dot: "bg-ok", label: "Checks passing" },
  fail: { dot: "bg-danger", label: "Checks failing" },
  pending: { dot: "bg-brass pulse", label: "Checks running" },
};

function PrCard({ pr }: { pr: PullRequest }) {
  const state = PR_STATE[pr.draft && pr.state === "OPEN" ? "DRAFT" : pr.state];
  const checks = pr.checks && CHECKS[pr.checks];
  return (
    <button
      onClick={() => openExternal(pr.url)}
      title={`Open #${pr.number} in your browser`}
      className="group w-full rounded-xl border border-line bg-raised px-3 py-2.5 text-left transition-colors hover:border-[#4a423a] hover:bg-hover/60"
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        <state.icon size={13} className={state.color} />
        <span className={state.color}>{state.label}</span>
        <span className="text-faint">#{pr.number}</span>
        <ArrowUpRight size={13} className="ml-auto text-faint transition-transform group-hover:translate-x-px group-hover:-translate-y-px group-hover:text-ink" />
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-ink">{pr.title}</p>
      <div className="mt-2 flex items-center gap-3 text-[12px] text-faint">
        <Diffstat add={pr.additions} del={pr.deletions} />
        {checks && (
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${checks.dot}`} />
            {checks.label}
          </span>
        )}
      </div>
    </button>
  );
}

function ContextMeter({ context }: { context?: { used: number; window: number } }) {
  if (!context) return <p className="text-[12.5px] text-faint">Fills in after the first reply</p>;
  const pct = Math.min(1, context.used / context.window);
  const color = pct > 0.85 ? "bg-danger" : pct > 0.6 ? "bg-[#d9a35b]" : "bg-brass";
  return (
    <>
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-ink tabular-nums">{tokens(context.used)}</span>
        <span className="text-faint tabular-nums">
          of {tokens(context.window)} ({Math.round(pct * 100)}%)
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
        <div className={`h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${Math.max(pct * 100, 1.5)}%` }} />
      </div>
    </>
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
