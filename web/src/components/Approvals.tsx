import { FilePen, Globe, SquareTerminal, Wrench } from "lucide-react";
import { useEffect } from "react";
import type { ApprovalRequest } from "../../../shared/protocol";
import { call } from "../rpc";
import { useApp } from "../store";

const AGENT = { claude: "Claude", codex: "Codex" } as const;

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
  const { icon: Icon, title, body, note } = describe(request);

  return (
    <div className="dock-in mb-2 overflow-hidden rounded-[18px] border border-brass/30 bg-raised shadow-[0_10px_40px_-16px_rgba(0,0,0,0.7)]">
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span className="flex size-6 items-center justify-center rounded-lg bg-brass/15 text-brass">
          <Icon size={13} strokeWidth={2} />
        </span>
        <p className="text-[13.5px] font-medium text-ink">{title}</p>
        {queue.length > 1 && <span className="ml-auto text-[11.5px] text-faint tabular-nums">1 of {queue.length}</span>}
      </div>
      {note && <p className="px-4 pt-1.5 pl-[50px] text-[12.5px] leading-relaxed text-dim">{note}</p>}
      {body && (
        <pre className="selectable mx-4 mt-2.5 max-h-48 overflow-auto rounded-xl border border-line bg-rail px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink/90">
          {body}
        </pre>
      )}
      <div className="flex items-center justify-end gap-1.5 px-3 pt-3 pb-3">
        <button
          onClick={() => answer(request.id, false)}
          className="flex h-8 items-center gap-2 rounded-xl px-3 text-[13px] text-dim transition-colors hover:bg-hover hover:text-ink"
        >
          Deny
          <kbd className="font-sans text-[11px] text-faint">esc</kbd>
        </button>
        <button
          onClick={() => answer(request.id, true)}
          className="flex h-8 items-center gap-2 rounded-xl bg-brass px-3.5 text-[13px] font-medium text-brass-ink transition hover:brightness-110 active:scale-[0.98]"
        >
          Allow
          <kbd className="font-sans text-[11px] text-brass-ink/60">↵</kbd>
        </button>
      </div>
    </div>
  );
}

function answer(approvalId: string, allow: boolean) {
  call("approval.answer", { approvalId, allow });
}

function describe(r: ApprovalRequest): { icon: typeof Wrench; title: string; body?: string; note?: string } {
  const who = AGENT[r.provider] ?? "The agent";
  const i = (r.input ?? {}) as Record<string, any>;
  switch (r.tool) {
    case "Bash":
      return { icon: SquareTerminal, title: `${who} wants to run a command`, body: `$ ${i.command}`, note: i.description };
    case "Write":
      return { icon: FilePen, title: `${who} wants to create a file`, body: i.file_path };
    case "Edit":
    case "MultiEdit":
      return { icon: FilePen, title: `${who} wants to edit a file`, body: i.file_path };
    case "Patch": {
      const changes: { path: string }[] = i.changes ?? [];
      return {
        icon: FilePen,
        title: `${who} wants to change ${changes.length === 1 ? "a file" : `${changes.length || ""} files`.trim()}`,
        body: changes.map((c) => c.path).join("\n") || undefined,
        note: i.reason,
      };
    }
    case "WebFetch":
      return { icon: Globe, title: `${who} wants to open a page`, body: i.url };
    case "WebSearch":
      return { icon: Globe, title: `${who} wants to search the web`, body: i.query };
    default:
      return {
        icon: Wrench,
        title: `${who} wants to use ${r.tool.replace(/^mcp__/, "").replaceAll("__", " ")}`,
        body: Object.keys(i).length ? JSON.stringify(i, null, 2) : undefined,
      };
  }
}
