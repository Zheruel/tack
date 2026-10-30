import { useEffect } from "react";
import type { ApprovalRequest } from "../../../shared/protocol";
import { call } from "../rpc";
import { useApp } from "../store";
import { PROVIDER_NAMES, ProviderLogo } from "./Logos";

// Docked on top of the composer. One request at a time: ↵ allows, Esc denies.
export function Approval({ threadId }: { threadId: string }) {
  const all = useApp((s) => s.approvals);
  const queue = Object.values(all).filter((a) => a.threadId === threadId);
  const request = queue[0];

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.shiftKey || e.altKey) return;
      const typing = e.target instanceof HTMLTextAreaElement && e.target.value.trim() !== "";
      if (e.key === "Enter" && !typing) answer(request.id, true);
      else if (e.key === "Escape") answer(request.id, false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true); // before the composer's own keys
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request?.id]);

  if (!request) return null;
  const { title, body, note } = describe(request);

  return (
    <div className="dock-in mb-2 flex items-center gap-3 rounded-2xl border border-brass/25 bg-raised py-2 pr-2 pl-3.5">
      <span title={`${PROVIDER_NAMES[request.provider]} is asking`}>
        <ProviderLogo provider={request.provider} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">
          {title}
          {note && <span className="ml-2 text-faint">{note}</span>}
          {queue.length > 1 && <span className="ml-2 text-faint">1 of {queue.length}</span>}
        </p>
        {body && (
          <p title={body} className="selectable truncate font-mono text-[12px] text-dim">
            {body}
          </p>
        )}
      </div>
      <button
        onClick={() => answer(request.id, false)}
        title="Deny (Esc)"
        className="h-7 shrink-0 rounded-lg px-2.5 text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-ink"
      >
        Deny
      </button>
      <button
        onClick={() => answer(request.id, true)}
        title="Allow (↵)"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-brass px-2.5 text-[12.5px] font-medium text-brass-ink transition hover:brightness-110 active:scale-[0.97]"
      >
        Allow
        <span className="text-[11px] text-brass-ink/55">↵</span>
      </button>
    </div>
  );
}

function answer(approvalId: string, allow: boolean) {
  call("approval.answer", { approvalId, allow });
}

function describe(r: ApprovalRequest): { title: string; body?: string; note?: string } {
  const i = (r.input ?? {}) as Record<string, any>;
  switch (r.tool) {
    case "Bash":
      return { title: "Run command", body: `$ ${i.command}`, note: i.description };
    case "Write":
      return { title: "Create file", body: i.file_path };
    case "Edit":
    case "MultiEdit":
      return { title: "Edit file", body: i.file_path };
    case "Patch": {
      const changes: { path: string }[] = i.changes ?? [];
      return {
        title: changes.length > 1 ? `Change ${changes.length} files` : "Change file",
        body: changes.map((c) => c.path).join(", ") || undefined,
        note: i.reason,
      };
    }
    case "WebFetch":
      return { title: "Open page", body: i.url };
    case "WebSearch":
      return { title: "Search the web", body: i.query };
    default:
      return {
        title: `Use ${r.tool.replace(/^mcp__/, "").replaceAll("__", " ")}`,
        body: Object.keys(i).length ? JSON.stringify(i, null, 2) : undefined,
      };
  }
}
