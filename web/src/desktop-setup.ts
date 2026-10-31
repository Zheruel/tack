import { inTauri, requestDesktopPermission } from "./native";
import { call, onConnect, onEvent } from "./rpc";

// Setup belongs to the app, including work in background chats and subagents.
export function startDesktopSetup() {
  if (!inTauri) return;
  const pending = new Set<string>();
  const revisions = new Map<string, number>();
  let requested = false;
  const update = (threadId: string, needsSetup?: boolean) => {
    if (needsSetup) pending.add(threadId);
    else pending.delete(threadId);
    if (!pending.size) requested = false;
    else if (!requested) {
      requested = true;
      void requestDesktopPermission("all").catch(() => {
        requested = false;
      });
    }
  };
  onEvent((event) => {
    if (event.type === "desktop") {
      revisions.set(event.threadId, (revisions.get(event.threadId) ?? 0) + 1);
      update(event.threadId, event.status.needsSetup);
    } else if (event.type === "thread.removed") update(event.threadId, false);
  });
  onConnect(() => {
    void call("state.get", {})
      .then(async ({ threads }) => {
        const running = new Set(
          threads.filter((t) => t.status === "running").map((t) => t.id),
        );
        for (const id of pending) if (!running.has(id)) update(id, false);
        await Promise.allSettled(
          [...running].map(async (threadId) => {
            const revision = revisions.get(threadId) ?? 0;
            const status = await call("desktop.get", { threadId });
            if ((revisions.get(threadId) ?? 0) === revision)
              update(threadId, status.needsSetup);
          }),
        );
      })
      .catch(() => {});
  });
}
