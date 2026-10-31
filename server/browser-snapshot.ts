import type { Locator, Page } from "playwright";

const MAX_TEXT = 24_000;
const MAX_REFS = 200;
let nextGeneration = 0;

// Inspired by T3 Code's ServerBrowserPage: keep Playwright's frame-aware refs,
// and namespace each snapshot so refs from another tab or capture cannot act.
export class BrowserRefs {
  private refs = new Map<string, string>();
  private generation = 0;
  private page?: Page;

  clear(): void {
    this.refs.clear();
    this.page = undefined;
    this.generation = ++nextGeneration;
  }

  async snapshot(page: Page): Promise<{ accessibilityTree: string; elements: { ref: string; description: string }[] }> {
    this.clear();
    const generation = this.generation;
    const tree = await page.ariaSnapshot({ mode: "ai", boxes: true, timeout: 10_000 });
    if (generation !== this.generation) throw new Error("The page changed while taking its snapshot. Take a new snapshot.");

    const elements: { ref: string; description: string }[] = [];
    const refs = new Map<string, string>();
    const lines: string[] = [];
    let length = 0;
    for (const line of tree.split("\n")) {
      // Only metadata at the end of a YAML item, never ref-like text in its name.
      const match = / \[ref=((?:f\d+)*e\d+)\](?=(?: \[[^\]\n]*\])*(?::|$))/.exec(line);
      const native = match?.[1];
      const ref = native && elements.length < MAX_REFS ? `tack-${generation}-${native}` : undefined;
      const rewritten = match ? line.replace(match[0], ref ? ` [ref=${ref}]` : "") : line;
      if (length + rewritten.length + 1 > MAX_TEXT) break;
      lines.push(rewritten);
      length += rewritten.length + 1;
      if (ref && native) {
        refs.set(ref, native);
        elements.push({
          ref,
          description: line.replace(/^\s*-\s*/, "").replace(/ \[(?:ref|box)=[^\]]*\]/g, "").replace(/:$/, "").slice(0, 300),
        });
      }
    }
    this.refs = refs;
    this.page = page;
    return { accessibilityTree: lines.join("\n"), elements };
  }

  locator(page: Page, selector: string): Locator {
    const ref = /^aria-ref=(tack-\d+-(?:f\d+)*e\d+)$/.exec(selector)?.[1];
    if (!ref) throw new Error("Use a snapshot locator such as aria-ref=tack-1-e1.");
    const native = this.refs.get(ref);
    if (!native || page !== this.page) throw new Error("Ref not found or expired. Take a new snapshot.");
    return page.locator(`aria-ref=${native}`);
  }
}
