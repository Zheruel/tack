import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Item } from "../../../shared/protocol";
import { useApp } from "../store";
import { ItemView, LiveLine, Steps } from "./ItemView";
import { tackTool } from "./TackTools";

export type Row = { key: string; kind: "item"; id: string } | { key: string; kind: "steps"; ids: string[] };

// Consecutive tool calls and thinking collapse into one "steps" row. Tack's own tools stand
// alone (visuals, answered questions). Historical task-list calls stay hidden.
function toRows(order: string[], itemOf: (id: string) => Item | undefined): Row[] {
  const rows: Row[] = [];
  for (const id of order) {
    const item = itemOf(id);
    const own = item?.kind === "tool" ? tackTool(item.name) : undefined;
    if (item?.kind === "tool" && ["todo", "mcp__tack__todo", "TodoWrite", "update_plan"].includes(item.name)) continue;
    const isStep = !own && (item?.kind === "tool" || item?.kind === "thinking");
    const last = rows[rows.length - 1];
    if (isStep && last?.kind === "steps") last.ids.push(id);
    else if (isStep) rows.push({ key: id, kind: "steps", ids: [id] });
    else rows.push({ key: id, kind: "item", id });
  }
  return rows;
}

// Virtualized transcript that sticks to the bottom while new content streams in,
// unless the reader has scrolled up.
export function Transcript({ threadId }: { threadId: string }) {
  const order = useApp((s) => s.transcripts[threadId]?.order);
  const running = useApp((s) => s.threads[threadId]?.status === "running");
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const settleUntil = useRef(0); // rows are still being measured after a jump
  const live = useRef(running);
  live.current = running;
  const [away, setAway] = useState(false);

  // Kinds never change once an item exists, so rows only need recomputing when the order does.
  const rows = useMemo(
    () => (order ? toRows(order, (id) => useApp.getState().transcripts[threadId]?.byId[id]) : []),
    [order, threadId],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    settleUntil.current = Date.now() + 800;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(toBottom, [threadId, !!order]);

  // Follow new content while a turn streams. Expanding a step by hand never scrolls.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stick.current && (live.current || Date.now() < settleUntil.current)) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [threadId, !!order]);

  // Only the reader scrolling up unpins; layout shifts from measuring rows never do.
  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom) stick.current = true;
    setAway(!atBottom && !stick.current);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) stick.current = false;
  };

  if (!order) return <div className="flex-1" />;
  const lastKey = rows[rows.length - 1]?.key;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        onWheel={onWheel}
        className="h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <div ref={content} className="transcript-content mx-auto w-full max-w-[768px] px-10 pt-6 pb-10">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]!;
              const live = running && row.key === lastKey;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                >
                  {row.kind === "steps" ? (
                    <Steps threadId={threadId} ids={row.ids} live={live} />
                  ) : (
                    <ItemRow threadId={threadId} itemId={row.id} streaming={live} />
                  )}
                </div>
              );
            })}
          </div>
          {running && <LiveLine threadId={threadId} />}
        </div>
      </div>
      {away && (
        <button
          onClick={toBottom}
          title="Jump to latest"
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised text-dim shadow-lg hover:text-ink"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  );
}

function ItemRow({ threadId, itemId, streaming }: { threadId: string; itemId: string; streaming: boolean }) {
  const item = useApp((s) => s.transcripts[threadId]?.byId[itemId]);
  if (!item) return null;
  return <ItemView threadId={threadId} item={item} streaming={streaming} />;
}
