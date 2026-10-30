import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronUp, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../store";
import { restartWhenIdle, update, updateAll, useUpdates, type UpdateId, type UpdateItem } from "../updates";
import { ClaudeLogo, OpenAILogo, TackLogo } from "./Logos";

function Logo({ id, className }: { id: UpdateId; className?: string }) {
  return id === "tack" ? <TackLogo className={className} /> : id === "codex" ? <OpenAILogo className={className} /> : <ClaudeLogo className={className} />;
}

// One pill at the bottom of the sidebar for every update, and one button to run them all.
export function Updates() {
  const items = useUpdates();
  const restartPending = useApp((s) => s.restartPending);
  const [open, setOpen] = useState(false);

  const actionable = items.filter((i) => i.state === "available" || i.state === "failed");
  const updating = items.some((i) => i.state === "updating");
  const ready = items.some((i) => i.state === "ready");
  const failed = items.some((i) => i.state === "failed");
  const allDone = items.length > 0 && items.every((i) => i.state === "done");

  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);

  if (!items.length) return null;

  const label = restartPending
    ? "Restarting when chats finish"
    : ready
      ? "Restart to finish updating"
      : updating
        ? "Updating…"
        : failed && !actionable.some((i) => i.state === "available")
          ? "Update failed"
          : allDone
            ? "Up to date"
            : `${actionable.length} ${actionable.length === 1 ? "update" : "updates"}`;

  return (
    <div className="shrink-0 px-2.5 pt-1 pb-3">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={`update-card group flex h-9 w-full items-center gap-2.5 rounded-xl border bg-raised/70 pr-2.5 pl-1.5 text-left outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised ${
            allDone ? "fade-away border-line/70" : ready ? "border-brass/40" : failed ? "border-danger/30" : "border-line/70 hover:border-line"
          }`}
        >
          <span className="flex -space-x-1.5">
            {items.map((i) => (
              <span key={i.id} className="flex size-6 items-center justify-center rounded-full bg-canvas ring-2 ring-rail">
                <Logo id={i.id} className="size-3.5" />
              </span>
            ))}
          </span>
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${failed && !updating ? "text-danger/90" : "text-ink"}`}>{label}</span>
          {updating ? (
            <span className="spin size-3.5 rounded-full border-[1.5px] border-line border-t-brass" />
          ) : allDone ? (
            <Check size={14} className="pop text-ok" />
          ) : (
            <ChevronUp size={14} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            className="dock-in z-50 w-[300px] rounded-2xl border border-line bg-raised p-1.5 shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)] outline-none"
          >
            <div className="flex h-9 items-center justify-between pr-1 pl-2.5">
              <span className="text-[12.5px] font-medium text-dim">Updates</span>
              {actionable.length > 0 && (
                <button
                  onClick={() => updateAll(items)}
                  className="h-7 rounded-lg bg-brass px-2.5 text-[12.5px] font-medium text-brass-ink transition hover:brightness-110 active:scale-[0.97]"
                >
                  {actionable.length > 1 ? "Update all" : "Update"}
                </button>
              )}
            </div>
            {items.map((i) => (
              <Row key={i.id} item={i} />
            ))}
            {ready && <RestartBar pending={restartPending} />}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function Row({ item }: { item: UpdateItem }) {
  const detail =
    item.state === "updating"
      ? item.percent !== undefined
        ? `Downloading ${item.percent}%`
        : "Updating…"
      : item.state === "ready"
        ? `${item.to} installed. Restart to use it`
        : item.state === "done"
          ? `Updated to ${item.to}`
          : item.state === "failed"
            ? "Update failed"
            : `${item.from} → ${item.to}`;

  return (
    <div title={item.error} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2">
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full border border-line/80 bg-canvas">
        <Logo id={item.id} className="size-3.5" />
        {item.state === "updating" && (
          <svg viewBox="0 0 32 32" className="spin absolute -inset-[3px] size-[32px]">
            <circle cx="16" cy="16" r="15" fill="none" stroke="var(--color-brass)" strokeWidth="1.5" strokeDasharray="24 72" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink">{item.name}</span>
        <span className={`block truncate text-[11.5px] tabular-nums ${item.state === "failed" ? "text-danger/90" : "text-faint"}`}>
          {detail}
        </span>
      </span>
      {item.state === "updating" && item.percent !== undefined && (
        <span className="h-1 w-14 overflow-hidden rounded-full bg-hover">
          <span className="block h-full rounded-full bg-brass transition-[width]" style={{ width: `${item.percent}%` }} />
        </span>
      )}
      {(item.state === "done" || item.state === "ready") && (
        <span className="pop flex size-4 items-center justify-center rounded-full bg-ok text-canvas">
          <Check size={10} strokeWidth={3.5} />
        </span>
      )}
      {item.state === "failed" && (
        <button onClick={() => update(item)} title="Retry" className="rounded-md p-1 text-danger hover:bg-danger/10">
          <RotateCw size={13} />
        </button>
      )}
    </div>
  );
}

function RestartBar({ pending }: { pending: boolean }) {
  const running = useApp((s) => Object.values(s.threads).filter((t) => t.status === "running").length);
  return (
    <div className="mt-1 flex items-center gap-2 border-t border-line/70 px-2.5 pt-2.5 pb-1">
      <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-faint">
        {pending
          ? `Waiting for ${running} ${running === 1 ? "chat" : "chats"} to finish`
          : running
            ? `Restarts after ${running} running ${running === 1 ? "chat finishes" : "chats finish"}`
            : "Tack restarts to finish"}
      </span>
      {!pending && (
        <button
          onClick={restartWhenIdle}
          className="h-7 shrink-0 rounded-lg bg-brass px-2.5 text-[12.5px] font-medium text-brass-ink transition hover:brightness-110"
        >
          Restart
        </button>
      )}
    </div>
  );
}
