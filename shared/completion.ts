// Private completion metadata rides in the primary model's final response. It never renders.
const START = "<tack-next-prompt>";
const OPEN = `\n${START}`;
const CLOSE = "</tack-next-prompt>";

function inFence(text: string) {
  let fence: { char: string; size: number } | undefined;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    if (!fence) fence = { char: run[0]!, size: run.length };
    else if (run[0] === fence.char && run.length >= fence.size && !match[2]!.trim()) fence = undefined;
  }
  return !!fence;
}

export function completionOf(raw: string): { text: string; suggestedPrompt?: string } {
  const starts = raw.startsWith(START);
  const index = starts ? 0 : raw.lastIndexOf(OPEN);
  if (index >= 0 && !inFence(raw.slice(0, index))) {
    const text = raw.slice(0, index).trimEnd();
    const tail = raw.slice(index + (starts ? START.length : OPEN.length));
    const close = tail.indexOf(CLOSE);
    if (close < 0) return { text }; // Keep incomplete metadata out of the streamed answer.
    const after = tail.slice(close + CLOSE.length);
    if (after.trim()) return { text: `${text}\n\n${after.trimStart()}` }; // Misplaced metadata cannot predict a completion.
    try {
      const value: unknown = JSON.parse(tail.slice(0, close));
      if (value && typeof value === "object" && !Array.isArray(value) && "prompt" in value && typeof value.prompt === "string") {
        const prompt = value.prompt.trim();
        if (prompt.length <= 240) return { text, suggestedPrompt: prompt };
      }
    } catch { /* A malformed prediction is discarded without damaging the answer. */ }
    return { text };
  }
  if (raw.length < START.length && START.startsWith(raw)) return { text: "" };
  // Hold the opening marker even when a stream splits it between arbitrary token chunks.
  for (let length = Math.min(OPEN.length - 1, raw.length); length > 0; length--) {
    if (raw.endsWith(OPEN.slice(0, length)) && !inFence(raw.slice(0, -length))) return { text: raw.slice(0, -length) };
  }
  return { text: raw };
}
