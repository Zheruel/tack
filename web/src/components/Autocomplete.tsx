import { FileText, Folder, Sparkles, SquareSlash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Command, Provider } from "../../../shared/protocol";
import { call } from "../rpc";

export interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  icon: "command" | "skill" | "file" | "folder";
  insert: string; // replaces the typed token
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

// "/" at the very start lists commands and skills; "@" after a space lists files.
export function useCompletion(text: string, caret: number, projectId: string | undefined, provider: Provider) {
  const [state, setState] = useState<Completion | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const seq = useRef(0);

  const before = text.slice(0, caret);
  const slash = before.match(/^\/([\w:.-]*)$/);
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

const ICONS = { command: SquareSlash, skill: Sparkles, file: FileText, folder: Folder };

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

  return (
    <div
      ref={list}
      onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
      className="dock-in absolute right-0 bottom-full left-0 z-40 mb-2 max-h-[288px] overflow-y-auto rounded-2xl border border-line bg-raised p-1.5 shadow-[0_16px_50px_-10px_rgba(0,0,0,0.75)]"
    >
      {completion.items.map((s, i) => {
        const Icon = ICONS[s.icon];
        return (
          <div
            key={s.key}
            onMouseMove={() => i !== completion.index && onHover(i)}
            onClick={() => onPick(s)}
            className={`flex h-9 cursor-default items-center gap-2.5 rounded-xl px-2.5 text-[13px] ${
              i === completion.index ? "bg-hover text-ink" : "text-dim"
            }`}
          >
            <Icon size={14} className={`shrink-0 ${i === completion.index ? "text-brass" : "text-faint"}`} />
            <span className={`shrink-0 ${s.icon === "file" || s.icon === "folder" ? "" : "font-mono text-[12.5px]"}`}>
              {s.label}
            </span>
            {s.detail && <span className="min-w-0 truncate text-[12px] text-faint">{s.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}
