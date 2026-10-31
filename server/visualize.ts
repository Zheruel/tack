import type { Command } from "../shared/protocol";

export const VISUALIZE_COMMAND: Command = {
  name: "visualize",
  description: "Turn ideas and data into beautiful, interactive visuals",
  kind: "skill",
  source: "app",
};

// Loaded on request, not repeated in every model's system prompt.
export const VISUALIZE_GUIDE = `Create an exceptional interactive visual in Tack with show. This is an inline visual, not a website or project change. Do not create project files unless asked.

Choose the composition before coding. For data, identify the comparison or decision and use the clearest chart. For explanations, use a diagram with a strong reading order. For a creative request, make one distinctive scene with depth and restrained motion. Never invent facts, measurements, scores, or evidence. Clarify missing data or important design choices with ask.

Art direction:
- One visual idea, one focal point. Use hierarchy, negative space, balanced density, and careful alignment. Avoid a dashboard of generic cards, decorative gradients, ornamental icons, tiny labels, or redundant headings. The visual should feel composed, not templated.
- The host already frames the visual. Leave the outer background transparent, with no outer card, border, or padding. Interior panels are fine when they clarify grouping. Use a concise heading only when it helps understanding, then quiet supporting text.
- Use the supplied 14px system font, 12px secondary labels, 500-weight headings and tabular numbers. Keep text legible; SVG labels must remain readable at phone width. Wrap long labels instead of shrinking them.
- Use --ink, --dim, --line, --accent, --ok, --danger, --raised, --font, --mono and --series-1 through --series-6. One measure uses one accent; color encodes meaningful categories consistently, never decoration. Thin neutral grids, direct labels, useful units, honest axes. Creative scenes may choose their own art-directed palette.
- Built-in helpers: viz-stack, viz-row, viz-grid, viz-panel, viz-label, viz-value, viz-muted. Use inline CSS/SVG/JS; no frameworks, external fonts, CDN scripts, network requests, or remote images. Local images can be supplied as absolute paths in img src and are inlined. Prefer SVG for crisp diagrams and charts, canvas for dense animation.

Interaction and fit:
- Add only interactions that improve the idea: hover/focus detail, selecting a meaningful series, a useful slider, or direct manipulation. Explain non-obvious interactions in one quiet line. Provide a keyboard alternative, semantic buttons and labels, and visible focus. Do not invent controls to fill space.
- Make the content responsive at 390px and comfortable around 720px. Stack when needed. Use SVG viewBox, flexible grids, and bounded widths. Do not use vh/dvh/svh/lvh units or percentage-height loops: the frame fits its contents. Canvas scenes need an explicit CSS height, ResizeObserver and devicePixelRatio scaling.
- Motion should be intentional and lightweight. Respect prefers-reduced-motion, pause work while hidden, and avoid rapid flashing. Expanding preserves the running iframe and its controls, so handle resize without resetting the state.

Verification and delivery:
- For a complex visual, call show_preview with the finished HTML. It returns a screenshot, runtime errors and measured height at the requested width. Inspect it, fix failures, and check 390px too when layout is dense. Skip preview for a trivial visual; do not loop on cosmetic guesses.
- Call show with title, html and optional height. The final visual appears inline with an expanded view. Do not paste HTML in a code block, announce a generated artifact, repeat its data in a table, or add export/download controls. A short interpretation is enough when needed. Do not claim interactions were tested from a screenshot alone.`;

export function expandVisualize(text: string): string {
  const match = text.match(/^\/(?:skill:)?visualize(?=\s|$)/i);
  if (!match) return text;
  const request = text.slice(match[0].length).trim();
  return `<tack-skill name="visualize">\n${VISUALIZE_GUIDE}\n</tack-skill>\n\n${request || "Help me choose what to visualize. Ask what idea or data I have in mind."}`;
}
