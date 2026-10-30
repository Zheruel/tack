import { Check } from "lucide-react";
import { useApp } from "../store";
import { restartWhenIdle, updateAll, useUpdates, type UpdateId } from "../updates";
import { ClaudeLogo, OpenAILogo, TackLogo } from "./Logos";

function Logo({ id }: { id: UpdateId }) {
  const cls = "size-3.5";
  return id === "tack" ? <TackLogo className={cls} /> : id === "codex" ? <OpenAILogo className={cls} /> : <ClaudeLogo className={cls} />;
}

// One slim row at the bottom of the sidebar for every update: logos, a word, one action.
export function Updates() {
  const items = useUpdates();
  const restartPending = useApp((s) => s.restartPending);
  if (!items.length) return null;

  const updating = items.some((i) => i.state === "updating");
  const ready = items.some((i) => i.state === "ready");
  const failed = items.some((i) => i.state === "failed");
  const waiting = items.filter((i) => i.state === "available" || i.state === "failed");
  const allDone = items.every((i) => i.state === "done");
  const percent = items.find((i) => i.percent !== undefined)?.percent;

  const [label, action, run] = updating
    ? [percent !== undefined ? `Updating ${percent}%` : "Updating…", null, null]
    : waiting.length
      ? [failed ? "Update failed" : `${waiting.length} ${waiting.length === 1 ? "update" : "updates"}`, failed ? "Retry" : "Update", () => updateAll(items)]
      : ready
        ? [restartPending ? "Restarting soon" : "Ready to restart", restartPending ? null : "Restart", restartWhenIdle]
        : [allDone ? "Up to date" : "", null, null];

  const details = items
    .map((i) => `${i.name}: ${i.state === "done" ? `updated to ${i.to}` : i.state === "ready" ? `${i.to} installed` : `${i.from} → ${i.to}`}${i.error ? ` (${i.error})` : ""}`)
    .join("\n");

  return (
    <div className="shrink-0 px-2.5 pt-1 pb-2.5">
      <button
        disabled={!run}
        onClick={() => run?.()}
        title={restartPending ? `${details}\nRestarts once running chats finish` : details}
        className={`update-card group relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left transition-colors enabled:hover:bg-hover/70 ${allDone ? "fade-away" : ""}`}
      >
        <span className="flex items-center gap-1">
          {items.map((i) => (
            <Logo key={i.id} id={i.id} />
          ))}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] tabular-nums ${failed && !updating ? "text-danger/90" : "text-dim group-enabled:group-hover:text-ink"}`}>
          {label}
        </span>
        {action && <span className={`shrink-0 text-[12.5px] font-medium ${failed ? "text-danger" : "text-brass"}`}>{action}</span>}
        {updating && <span className="spin size-3 shrink-0 rounded-full border-[1.5px] border-line border-t-brass" />}
        {allDone && <Check size={13} className="pop shrink-0 text-ok" />}
        {updating && percent !== undefined && (
          <span className="absolute right-2.5 bottom-0 left-2.5 h-px bg-line">
            <span className="block h-full bg-brass transition-[width]" style={{ width: `${percent}%` }} />
          </span>
        )}
      </button>
    </div>
  );
}
