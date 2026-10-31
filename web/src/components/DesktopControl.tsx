import * as Popover from "@radix-ui/react-popover";
import { Loader2, Monitor, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopStatus } from "../../../shared/protocol";
import { inTauri, requestDesktopPermission } from "../native";
import { call, onConnect, onEvent } from "../rpc";

export function DesktopControl({ threadId }: { threadId: string }) {
  const [status, setStatus] = useState<DesktopStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let revision = 0;
    setStatus(undefined);
    setError("");
    const update = (value: DesktopStatus) => {
      setStatus(value);
    };
    const refresh = () => {
      const started = ++revision;
      void call("desktop.get", { threadId })
        .then((value) => {
          if (live && revision === started) {
            setError("");
            update(value);
          }
        })
        .catch((error) => {
          if (live && revision === started) setError(String(error));
        });
    };
    const off = onEvent((event) => {
      if (event.type === "desktop" && event.threadId === threadId) {
        revision++;
        update(event.status);
      }
    });
    const disconnect = onConnect(refresh);
    refresh();
    return () => {
      live = false;
      off();
      disconnect();
    };
  }, [threadId]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Computer use"
        title="Computer use"
        className={`relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-ink ${status?.active ? "bg-brass/10 text-brass" : "text-dim"}`}
      >
        <Monitor size={15} strokeWidth={1.8} />
        {status?.active && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-brass" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-raised p-4 text-[13px] shadow-xl outline-none"
        >
          <div className="mb-2 flex items-center gap-2 font-medium text-ink">
            <Monitor size={15} />
            Computer use
            {status?.active && (
              <span className="ml-auto text-[11px] text-brass">Working</span>
            )}
          </div>
          {!status ? (
            <p className="text-dim">Checking availability…</p>
          ) : !status.available ? (
            <p className="text-dim">
              Computer use is unavailable in this build of Tack.
            </p>
          ) : (
            <>
              <p className="mb-3 leading-relaxed text-dim">
                Ask Claude or Codex to use a Mac app. Tack works in the
                background and brings windows forward only when needed.
              </p>
              {!!status.apps.length && (
                <div className="mb-3 rounded-lg border border-line px-3 py-2">
                  <p className="mb-1 text-[11px] text-faint">
                    Apps in this chat
                  </p>
                  {status.apps.map((app) => (
                    <p
                      key={app.bundleId}
                      className="truncate py-0.5 text-ink"
                      title={app.bundleId}
                    >
                      {app.name}
                    </p>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setStatus(await call("desktop.revoke", { threadId })),
                      )
                    }
                    className="mt-2 flex items-center gap-1.5 rounded-md py-1 text-danger hover:underline disabled:opacity-50"
                  >
                    <Square size={12} />
                    Stop and revoke access
                  </button>
                </div>
              )}
              <p className="mb-2 text-[12px] leading-relaxed text-dim">
                {status.needsSetup
                  ? "Waiting for macOS permission. Tack will continue automatically."
                  : "First use opens macOS permission setup automatically."}
              </p>
              <div className="flex flex-col gap-1">
                <button
                  disabled={busy || !inTauri}
                  onClick={() => run(() => requestDesktopPermission("all"))}
                  className="rounded-md border border-line px-3 py-1.5 text-left text-ink hover:bg-hover disabled:opacity-50"
                >
                  Enable computer use…
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                {inTauri
                  ? "Allow Tack in System Settings. Restart only if macOS requests it."
                  : "Open Tack’s desktop app to grant macOS permissions."}
              </p>
            </>
          )}
          {busy && (
            <Loader2
              aria-label="Working"
              size={14}
              className="mt-2 animate-spin text-dim"
            />
          )}
          {error && (
            <p
              role="status"
              className="mt-2 break-words text-[12px] text-danger"
            >
              {error}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
