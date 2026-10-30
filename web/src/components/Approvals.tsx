import { call } from "../rpc";
import { useApp } from "../store";

export function Approvals({ threadId }: { threadId: string }) {
  const all = useApp((s) => s.approvals);
  const approvals = Object.values(all).filter((a) => a.threadId === threadId);
  if (!approvals.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {approvals.map((a) => {
        const input = a.input as Record<string, any>;
        const detail = input.command ?? input.file_path ?? input.url ?? JSON.stringify(input);
        return (
          <div key={a.id} className="rounded-xl border border-brass/30 bg-raised px-4 py-3">
            <p className="text-[13px] text-ink">
              Allow <span className="font-medium">{a.tool}</span>?
            </p>
            <pre className="selectable mt-1.5 max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-dim">
              {String(detail)}
            </pre>
            <div className="mt-3 flex gap-2">
              <button
                autoFocus
                onClick={() => call("approval.answer", { approvalId: a.id, allow: true })}
                className="rounded-lg bg-brass px-3 py-1 text-[13px] font-medium text-brass-ink hover:brightness-110"
              >
                Allow
              </button>
              <button
                onClick={() => call("approval.answer", { approvalId: a.id, allow: false })}
                className="rounded-lg px-3 py-1 text-[13px] text-dim hover:bg-hover hover:text-ink"
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
