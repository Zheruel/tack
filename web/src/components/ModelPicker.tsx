import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelOption, Provider } from "../../../shared/protocol";
import { useApp } from "../store";
import { PROVIDER_NAMES, ProviderLogo } from "./Logos";

// Providers down a narrow rail, their models beside it. Adding a provider adds one icon.
export function ModelPicker({ value, onPick }: { value: string; onPick: (model: string) => void }) {
  const models = useApp((s) => s.models);
  const current = models.find((m) => m.value === value);
  const providers = [...new Set(models.map((m) => m.provider))];
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(current?.provider ?? "claude");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(current?.provider ?? providers[0] ?? "claude");
    setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown: ModelOption[] = q
    ? models.filter((m) => `${m.label} ${m.value} ${PROVIDER_NAMES[m.provider]}`.toLowerCase().includes(q))
    : models.filter((m) => m.provider === provider);
  const latest = shown.filter((m) => m.group === "latest");
  const older = shown.filter((m) => m.group === "more");
  const ordered = [...latest, ...older];

  useEffect(() => {
    const i = ordered.findIndex((m) => m.value === value);
    setActive(i >= 0 ? i : 0);
  }, [provider, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (m: ModelOption) => {
    onPick(m.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + by + ordered.length) % Math.max(ordered.length, 1));
    } else if (e.key === "Enter" && ordered[active]) {
      e.preventDefault();
      pick(ordered[active]!);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !query) {
      e.preventDefault();
      const i = providers.indexOf(provider) + (e.key === "ArrowRight" ? 1 : -1);
      setProvider(providers[(i + providers.length) % providers.length]!);
    }
  };

  const row = (m: ModelOption, i: number) => (
    <div
      key={m.value}
      data-index={i}
      onMouseMove={() => i !== active && setActive(i)}
      onClick={() => pick(m)}
      className={`flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-1.5 ${i === active ? "bg-hover" : ""}`}
    >
      {q && <ProviderLogo provider={m.provider} className="size-3.5" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{m.label}</span>
        {m.description && <span className="block truncate text-[11.5px] text-faint">{m.description.replace(/\.$/, "")}</span>}
      </span>
      {m.value === value && <Check size={13} className="shrink-0 text-brass" />}
    </div>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        title="Model"
        className="flex h-[30px] items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] text-ink/80 outline-none transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
      >
        {current && <ProviderLogo provider={current.provider} className="size-3.5" />}
        {current?.label ?? value}
        <ChevronDown size={13} className="text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          onKeyDown={onKeyDown}
          className="z-50 flex h-[340px] w-[400px] overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)] outline-none"
        >
          {providers.length > 1 && (
            <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line/70 bg-rail/50 py-2">
              {providers.map((p) => {
                const selected = !q && p === provider;
                return (
                  <button
                    key={p}
                    onClick={() => {
                      setProvider(p);
                      setQuery("");
                    }}
                    title={PROVIDER_NAMES[p]}
                    className={`relative flex size-9 items-center justify-center rounded-xl transition-colors ${
                      selected ? "bg-hover" : "opacity-60 hover:bg-hover/60 hover:opacity-100"
                    }`}
                  >
                    {selected && <span className="absolute top-2 bottom-2 -left-1.5 w-[3px] rounded-full bg-brass" />}
                    <ProviderLogo provider={p} className="size-[18px]" />
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line/70 px-3.5">
              <Search size={14} className="text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${q ? "all" : PROVIDER_NAMES[provider]} models`}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              />
            </div>
            <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {latest.map((m, i) => row(m, i))}
              {older.length > 0 && (
                <>
                  <div className="px-2.5 pt-2.5 pb-1 text-[11.5px] text-faint">Older</div>
                  {older.map((m, i) => row(m, latest.length + i))}
                </>
              )}
              {!ordered.length && <p className="px-2.5 py-2 text-[12.5px] text-faint">No models match</p>}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
