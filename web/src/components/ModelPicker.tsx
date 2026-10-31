import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelOption, Provider } from "../../../shared/protocol";
import { useApp } from "../store";
import { PROVIDER_NAMES, ProviderLogo } from "./Logos";

// T3 Code's picker: providers down a narrow rail, their models beside it with ⌘1–⌘9 jumps,
// older models folded under "Legacy models". Adding a provider adds one icon.
export function ModelPicker({ value, onPick }: { value: string; onPick: (model: string) => void }) {
  const models = useApp((s) => s.models);
  const current = models.find((m) => m.value === value);
  const providers = [...new Set(models.map((m) => m.provider))];
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(current?.provider ?? "claude");
  const [query, setQuery] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(current?.provider ?? providers[0] ?? "claude");
    setQuery("");
    setLegacy(current?.group === "more");
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown: ModelOption[] = q
    ? models.filter((m) => `${m.label} ${m.value} ${PROVIDER_NAMES[m.provider]}`.toLowerCase().includes(q))
    : models.filter((m) => m.provider === provider);
  const latest = q ? shown : shown.filter((m) => m.group === "latest");
  const older = q ? [] : shown.filter((m) => m.group === "more");
  const ordered = legacy ? [...latest, ...older] : latest;

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
    if (e.metaKey && /^[1-9]$/.test(e.key)) {
      const m = latest[Number(e.key) - 1];
      if (m) {
        e.preventDefault();
        pick(m);
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
      className={`flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 ${i === active ? "bg-ink/[0.09]" : ""}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] leading-snug text-ink">{m.label}</span>
        {q && (
          <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-faint">
            <ProviderLogo provider={m.provider} className="size-3" />
            {PROVIDER_NAMES[m.provider]}
          </span>
        )}
      </span>
      {!q && m.group === "latest" && i < 9 && <Kbd>⌘{i + 1}</Kbd>}
      <Check size={14} className={`shrink-0 text-ink ${m.value === value ? "" : "invisible"}`} />
    </div>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        title="Model"
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13.5px] font-medium text-ink/80 outline-none transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
      >
        {current && <ProviderLogo provider={current.provider} className="size-4" />}
        {current?.label ?? value}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          onKeyDown={onKeyDown}
          className="menu-glass z-50 flex max-h-[346px] w-[360px] overflow-hidden outline-none"
        >
          {providers.length > 1 && !q && (
            <div className="flex w-11 shrink-0 flex-col gap-1 border-r border-white/[0.06] bg-black/20 p-1">
              {providers.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setProvider(p);
                    setLegacy(false);
                  }}
                  title={PROVIDER_NAMES[p]}
                  className="relative flex aspect-square items-center justify-center rounded-md transition-colors hover:bg-white/[0.08]"
                >
                  <ProviderLogo provider={p} className="size-5" />
                  {p === provider && <span className="absolute top-1/2 -right-1 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brass" />}
                </button>
              ))}
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <label className="mx-3 mt-2.5 mb-0.5 flex items-center gap-1.5 border-b border-white/[0.08] pb-1.5 transition-colors focus-within:border-brass">
              <Search size={14} className="shrink-0 text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                className="h-6 min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
              />
            </label>
            <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1.5 pr-px pl-2">
              {latest.map((m, i) => row(m, i))}
              {older.length > 0 && (
                <>
                  <button
                    onClick={() => setLegacy(!legacy)}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-ink/[0.06]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] leading-snug text-ink">Legacy models</span>
                      <span className="block text-[11.5px] text-faint">
                        {older.length} {older.length === 1 ? "model" : "models"}
                      </span>
                    </span>
                    <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${legacy ? "rotate-90" : ""}`} />
                  </button>
                  {legacy && older.map((m, i) => row(m, latest.length + i))}
                </>
              )}
              {!shown.length && <p className="px-2 py-3 text-[12.5px] text-faint">No models found</p>}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="shrink-0 rounded border border-white/5 bg-ink/[0.07] px-1 font-sans text-[10.5px] text-dim">{children}</kbd>
  );
}
