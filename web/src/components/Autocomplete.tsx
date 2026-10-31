import { useEffect, useRef, useState } from "react";
import type { Command, Provider } from "../../../shared/protocol";
import { call } from "../rpc";

export interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  icon: "command" | "skill" | "file" | "folder";
  insert: string; // replaces the typed token
  source?: "app";
}

export interface Completion {
  items: Suggestion[];
  index: number;
  start: number; // text range the suggestion replaces
  end: number;
}

// Commands rarely change while you type; fetch once per project and provider.
const commandCache = new Map<string, Promise<Command[]>>();

function commands(projectId: string, provider: Provider) {
  const key = `${projectId}:${provider}`;
  let hit = commandCache.get(key);
  if (!hit) {
    hit = call("commands.list", { projectId, provider }).catch(() => []);
    hit.then((list) => !list.length && commandCache.delete(key));
    commandCache.set(key, hit);
  }
  return hit;
}

// Names of the commands and skills the composer can colour once they are typed in full.
export function useCommandNames(projectId: string | undefined, provider: Provider) {
  const [names, setNames] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    if (!projectId) return setNames(new Set());
    commands(projectId, provider).then((list) => live && setNames(new Set(list.map((c) => c.name))));
    return () => void (live = false);
  }, [projectId, provider]);
  return names;
}

// "/" at the start of a word lists commands and skills (a second "/" makes it a path, so no menu);
// "@" after a space lists files.
export function useCompletion(text: string, caret: number, projectId: string | undefined, provider: Provider) {
  const [state, setState] = useState<Completion | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const seq = useRef(0);

  // The first lookup starts a CLI; warm it while the box is still empty so "/" answers at once.
  useEffect(() => {
    if (projectId) void commands(projectId, provider);
  }, [projectId, provider]);

  const before = text.slice(0, caret);
  const slash = before.match(/(?:^|\s)\/([\w:.-]*)$/);
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  const token = slash ? `/${slash[1]}` : mention ? `@${mention[1]}` : null;

  useEffect(() => {
    const id = ++seq.current;
    if (!projectId || !token || token === dismissed) return setState(null);
    const query = token.slice(1);
    const start = caret - token.length;
    const show = (items: Suggestion[]) => id === seq.current && setState(items.length ? { items, index: 0, start, end: caret } : null);

    if (slash) {
      commands(projectId, provider).then((list) => {
        const q = query.toLowerCase();
        const ranked = list
          .map((c) => ({ c, at: c.name.toLowerCase().indexOf(q) }))
          .filter((r) => r.at >= 0)
          .sort((a, b) => a.at - b.at || a.c.name.length - b.c.name.length);
        show(
          ranked.slice(0, 40).map(({ c }) => ({
            key: c.name,
            label: `/${c.name}`,
            detail: c.description,
            icon: c.kind,
            insert: `/${c.name} `,
            source: c.source,
          })),
        );
      });
    } else {
      call("files.search", { projectId, query }).then((paths) =>
        show(
          paths.map((p) => ({
            key: p,
            label: p.split("/").pop() || p,
            detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined,
            icon: p.endsWith("/") ? "folder" : "file",
            insert: `@${p} `,
          })),
        ),
      );
    }
  }, [token, projectId, provider, dismissed, caret]);

  return {
    completion: state,
    move: (by: number) =>
      setState((s) => (s ? { ...s, index: (s.index + by + s.items.length) % s.items.length } : s)),
    dismiss: () => {
      setDismissed(token);
      setState(null);
    },
    setIndex: (index: number) => setState((s) => (s ? { ...s, index } : s)),
  };
}


export function CompletionMenu({
  completion,
  onPick,
  onHover,
}: {
  completion: Completion;
  onPick: (s: Suggestion) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.children[completion.index]?.scrollIntoView({ block: "nearest" });
  }, [completion.index]);

  // Tucked under the composer card's top edge, as in T3.
  return (
    <div
      ref={list}
      onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
      className="composer-attached absolute right-[22px] bottom-[calc(100%-17px)] left-[22px] z-0 max-h-[300px] overflow-y-auto p-2 pb-[25px] select-none"
    >
      {completion.items.map((s, i) => (
        <div
          key={s.key}
          onMouseMove={() => i !== completion.index && onHover(i)}
          onClick={() => onPick(s)}
          className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${i === completion.index ? "bg-hover" : ""}`}
        >
          <span className="max-w-[45%] shrink-0 truncate font-medium text-ink">{s.label}</span>
          {s.detail && <span className="min-w-0 flex-1 truncate text-faint">{s.detail}</span>}
          {s.icon === "skill" && <span className="ml-auto shrink-0 rounded bg-ink/[0.07] px-1.5 text-[11px] text-dim">{s.source === "app" ? "App" : "Skill"}</span>}
        </div>
      ))}
    </div>
  );
}
