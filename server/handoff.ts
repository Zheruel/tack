// Carrying a thread across providers. Each provider keeps its own native session; when the
// thread comes back to one, it only needs what happened while it was away. That slice is
// rendered as plain text and sent ahead of the user's message.
//
// Messages retain their decisions, with unusually large entries bounded; tools become one line each, with the
// tail of failed output, since the files themselves are on disk for the new agent to read.

import { wrapUpOf, type Item, type Provider } from "../shared/protocol";

const BUDGET = 48_000; // characters, roughly 12k tokens
const FAILED_OUTPUT = 600;
const ENTRY_BUDGET = BUDGET / 2 - 128;

const NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export function handoff(items: Item[], from: Provider): { text: string; carried: number } | undefined {
  const lines = items.map(render).filter((l): l is string => !!l).map((line) => bound(line, ENTRY_BUDGET));
  if (!lines.length) return undefined;

  // Keep the newest lines that fit; say how much was left out.
  let size = 0;
  let start = lines.length;
  while (start > 0 && size + lines[start - 1]!.length < BUDGET) size += lines[--start]!.length + 1;
  const kept = lines.slice(start);
  const dropped = start ? `(${start} earlier entries omitted)\n` : "";

  const text =
    `<handoff>\nYou are taking over this conversation from ${NAMES[from]}. ` +
    `Here is what happened while it was in charge. The working tree already reflects it; read files rather than trusting summaries.\n\n` +
    dropped +
    kept.join("\n") +
    `\n</handoff>\n\n`;
  return { text, carried: kept.length };
}

function render(item: Item): string | undefined {
  switch (item.kind) {
    case "user": {
      const attachments = item.attachments?.map((attachment) => {
        const path = (attachment as { path?: string }).path;
        return path ? `- ${attachment.name}: ${path}` : `- ${attachment.name} (saved reference unavailable)`;
      });
      return `User: ${item.text}${attachments?.length ? `\nAttached files:\n${attachments.join("\n")}` : ""}`;
    }
    case "assistant":
      return `Assistant: ${item.text}`;
    case "tool":
      if (wrapUpOf(item)) return `Assistant: ${wrapUpOf(item)!.summary}`;
      return `- ${toolLine(item)}${item.status === "error" && item.output ? `\n  failed: ${tail(item.output)}` : ""}`;
    case "error":
      return `Error: ${item.text}`;
    case "turn":
      return item.error && item.error !== "Interrupted" ? `(turn failed: ${item.error})` : undefined;
    default:
      return undefined; // thinking and earlier handoffs carry nothing the next agent needs
  }
}

function toolLine(tool: Extract<Item, { kind: "tool" }>): string {
  const i = (tool.input ?? {}) as Record<string, any>;
  const name = tool.name.replace(/^mcp__tack__/, "");
  if (/^agent(?:_status|_send|_cancel)?$/.test(name) && tool.output) {
    try {
      const result = JSON.parse(tool.output);
      const identity = result.id ?? result.threadId;
      if (identity) return `${name}: id ${identity}, generation ${result.generation ?? "latest"}, status ${result.status ?? "unknown"}`;
    } catch { /* Legacy tool results remain readable as text. */ }
    return `${name}: ${bound(tool.output, FAILED_OUTPUT)}`;
  }
  switch (tool.name) {
    case "Bash":
      return `ran \`${String(i.command ?? "").slice(0, 300)}\``;
    case "Read":
      return `read ${i.file_path}`;
    case "Write":
      return `wrote ${i.file_path}`;
    case "Edit":
    case "MultiEdit":
      return `edited ${i.file_path}`;
    case "Patch":
      return `changed ${(i.changes ?? []).map((c: any) => c.path).join(", ")}`;
    case "Grep":
    case "Glob":
      return `searched for ${i.pattern}`;
    case "WebSearch":
      return `searched the web for ${i.query}`;
    case "WebFetch":
      return `fetched ${i.url}`;
    default:
      return `used ${tool.name}`;
  }
}

const tail = (s: string) => (s.length > FAILED_OUTPUT ? "…" + s.slice(-FAILED_OUTPUT) : s).replace(/\n/g, "\n  ");

function bound(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker = "\n[Entry truncated; beginning and end preserved]\n";
  const available = budget - marker.length;
  return text.slice(0, Math.floor(available / 2)) + marker + text.slice(-Math.ceil(available / 2));
}
