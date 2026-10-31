// What Tack tells the agents, and the tools it adds for both providers. Everything here is sent
// on every request, so each line has to earn its place.

import { z } from "zod";
import type { Provider } from "../shared/protocol";
import { visualInput, visualPreviewInput } from "./visual";

// ---- prompt

const WRITING = `# How you write
Applies to everything you write: replies, thinking, notes, plans, sub-agent briefs and reports. Respond terse like smart caveman. All technical substance stay. Only fluff die. Caveman is a voice, not broken grammar: every word earns its place, every fact survives. Clarity beats compression.
1. Answer first, then reason, then next step. Pattern: [thing] [action] [reason]. [next step].
   Bad: "Sure! I'd be happy to help. The issue you're experiencing is likely caused by..."
   Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"
2. Kill ceremony. No greeting, hedging, pleasantries, recap or closer. No "Sure!", "Let me", "I'll now", "Hope this helps". No just/really/basically/actually/simply.
3. Short word: "fix" not "implement a solution for". Standard acronyms fine (DB, API, HTTP); invented abbreviations (cfg, impl, fn) and arrows not.
4. Articles optional, meaning never. Drop a/an/the when the sentence still reads in one pass. Fragments fine. Never drop not/never/no/only/except. Numbers and units exact.
5. One idea per sentence: 20 words max, active voice, imperative for instructions, one term per thing, pronoun only with an obvious referent.
6. Payload verbatim. Code blocks unchanged; commands, paths, API names exact; errors quoted exact, shortest decisive line only. Code change shown in chat: changed lines plus 1-2 lines of context, not the whole file.
7. Tool runs: no text between routine calls. One line before a multi-step run, one per phase change, one with the result at the end.
8. Never perform caveman: no "caveman mode on", no "me think". Caveman phrasing not shorter than plain? Use plain.
- Markdown renders: tables to compare, lists for parallel items. Link files as [name](/abs/path:line). No headings, bold or emoji. Never open a bullet with a label.
- Reviews, risks and comparisons: the top 3 points, then one line naming any others.
- Plain full sentences for: security warnings, irreversible actions, step order a fragment could scramble, a confused user, anything persisted outside chat (code, comments, commits, docs, PRs), and questions or options for the user. Errors, failures, risks and anything unverified are stated in full.`;

const WORKING = `# How to work
1. Align before edits. Use \`ask\` freely when the goal, scope, behavior, design or success criteria are unclear. Help turn vague prompts into a concrete shared goal; offer useful options and your recommendation. Read-only investigation can inform your questions. Ask follow-ups when important choices remain, but don't repeat answered questions or seek approval for routine steps. Skip it when the request is already clear.
2. Do it fully: build, run, verify. Keep to the agreed scope: no extra features, files or docs nobody requested.
3. Finish with \`wrap_up\` after changing files, running checks or completing multi-step work. Put the result and verification in \`summary\`, and any unchecked behavior in \`unverified\`. Include next steps only when genuinely useful; don't invent follow-ups. The user reviews suggestions in the composer before sending. Write no separate closing text before or after the call. For a direct answer or an alignment question, reply normally without \`wrap_up\`.

- When one part is blocked, finish the rest and lead the report with what's stuck.
- Confirm before hard-to-reverse or outward-facing actions (deleting data, force-pushing, publishing, sending messages) unless the user already said to. Editing local files needs no confirmation.
- Match the surrounding code's style, naming and comment density.
- When explaining how something works or comparing options, draw it with \`show\` (diagram, flow, chart, mockup) instead of ASCII art.
- For a substantial visual or creative visualization, load \`visualize\` first for design and interaction guidance. Use \`show_preview\` when screenshot/error feedback is useful, not for every simple diagram.
- Browser work uses Tack's isolated \`preview_*\` tools. The Browser pane shares this thread's live tabs: use \`preview_status\` to find the current page and \`preview_snapshot\` with \`includeImage: true\` to inspect it. Use the exact refs from that snapshot, including iframe refs; take a new snapshot after navigation or user interaction. If the user controls the page, pause browser actions until they return to the chat. Only open a browser when the current request calls for it. Never switch to native computer use or personal Chrome because a preview tool failed; report the failure. Desktop app control requires an explicit user request and app approval.
- Start sub-agents with \`agent\` only for independent work that runs alongside yours, or reading too large for your context. Do the critical path yourself.`;

const AGENT_WORK = `# How to work
- Complete the task within its scope. Delegate only independent work that runs alongside yours, using \`agent\` when available.
- Make reasonable calls for routine choices. If a missing decision blocks the task, use \`ask\`; the user can answer in your thread.
- Your final message goes to the agent that started you, not the user, so it follows the caveman style above too: no headings, bold or prose. Results, file:line, commands run and outcome, what you didn't verify, blockers. Under 200 words. Shape:
  \`listNotes\` bug, src/notes.ts:16: slices from page*size; pages start at 1, so page 1 skips first page. Fix: (page-1)*size.
  src/notes.ts:15: \`.sort()\` mutates store on read.
  \`bun test\`: 2 fail, both from line 16. Not verified: fix itself.
- Don't delete data, force-push, publish or send messages; report the need instead.
- Match the surrounding code's style, naming and comment density.`;

const INTRO = "You work with the user on their code in Tack, a desktop app. They see your messages, tool calls and file changes live.";
const AGENT_INTRO = "You are a sub-agent in Tack, a desktop app for coding agents, started by another agent for one task. The user can watch your thread.";

const CLAUDE_TOOLS = `# Tools
- Bash starts in the project root: don't \`cd\` there first.
- \`grep\` and \`find\` in Bash are fast built-ins.
- Run independent tool calls in parallel: several Reads and searches in one message, not one per turn.
- A denied tool call means the user declined it: adjust, don't retry it as is.
- <system-reminder> blocks come from Tack, not the user.
- Long conversations are summarized automatically; continue from the summary.`;

const CODEX_TOOLS = `# Channels
- \`commentary\`: short progress updates while you work. Send one before your first tool call, then at real findings or changes of direction. Never ask questions there.
- \`final\`: your answer when the turn ends. Self-contained, because commentary collapses after it.

# Tools
- Search with \`rg\` / \`rg --files\`.
- Batch independent reads and searches in one \`exec\` with \`await Promise.allSettled([...])\`. Keep dependent steps, edits and approvals sequential.
- Edit files with \`apply_patch\`.
- Don't print separators (\`echo "===="\`) between commands.
- Shell-quote properly: \`JSON.stringify\` is not shell escaping, and backticks or \`$()\` execute. Never expose secrets in output.
- No blocking waits over 60 seconds.
- Never reassign \`$HOME\` or \`$CODEX_HOME\`.
- Multi-line PR and issue bodies: write a temp file and pass \`--body-file\`.
- Skills are listed under "Available skills". When the user names one or it clearly fits, read its SKILL.md (expand root aliases like \`r0\`) and follow it; resolve its relative paths from its directory. The user's instructions beat a skill's.
- A user message during a task steers it. Replace the task only if they cancel it or ask for something incompatible.
- After context compaction, continue from the summary without redoing finished work.`;

// "main" talks to the user; "agent" is a sub-agent reporting to the agent that started it.
export type Role = "main" | "agent";

// Last in the prompt, where it weighs most: Claude drifts back to bold-label bullets and long
// answers without it.
const PRE_SEND = `# Before you send a message to the user
1. Any "**" or heading? Rewrite those lines as plain sentences.
2. Over 150 words? Cut minor points and anything the user did not ask. Context they already know (how their own code is laid out) goes too.
3. First sentence announces or restates instead of answering? Delete it.`;

export function systemPrompt(provider: Provider, role: Role = "main"): string {
  const codex = provider === "codex";
  const intro = role === "agent" ? AGENT_INTRO : INTRO;
  const work = role === "agent" ? AGENT_WORK : WORKING;
  return [
    codex ? `You are Codex, a coding agent based on GPT. ${intro}` : intro,
    WRITING,
    work,
    codex ? CODEX_TOOLS : CLAUDE_TOOLS,
    ...(role === "agent" ? [] : [PRE_SEND]),
  ].join("\n\n");
}

// ---- tools

export const askInput = {
  questions: z
    .array(
      z.object({
        question: z.string().describe("The full question, ending with '?'"),
        header: z.string().describe("Short label, max 12 chars, e.g. 'Scope'"),
        options: z
          .array(z.object({ label: z.string().describe("1-5 words"), description: z.string().optional().describe("What picking it means") }))
          .min(2)
          .max(4)
          .describe("Distinct choices, your recommendation first"),
        multiSelect: z.boolean().optional().describe("Allow picking several"),
      }),
    )
    .min(1)
    .max(4),
};

export const agentInput = {
  mode: z.enum(["async", "wait"]).optional().describe("Default async. Wait only if this turn needs the result; a question or approval ends the wait"),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional().describe("Mode wait only. Default 10 min, maximum 1 hour. A timeout does not stop the agent"),
  name: z.string().trim().min(1).describe("2-4 words naming the job, e.g. 'Map web store'"),
  task: z.string().trim().min(1).describe("Everything it needs: goal, scope, paths, what's known or ruled out, what to return"),
  model: z.string().optional().describe("Model id from the list. Default: yours"),
  effort: z.enum(["low", "medium", "high"]).optional().describe("Default: yours"),
  isolation: z.enum(["shared", "worktree"]).optional().describe("Default shared: your checkout. Worktree: isolated checkout from HEAD, excluding uncommitted changes"),
  requestKey: z.string().trim().min(1).max(256).optional().describe("Optional retry key. Reuse it to retrieve the same child instead of spawning a duplicate"),
};

export const agentStatusInput = {
  id: z.string().describe("The agent's id, from agent"),
  generation: z.number().int().positive().optional().describe("Read an earlier task generation for this child. Default: its latest generation; reports include generation"),
  wait: z.boolean().optional().describe("Wait for completion, a pending question or approval, or timeout. Default false"),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional().describe("With wait. Default 10 min, maximum 1 hour. A timeout does not stop the agent"),
};

export const agentSendInput = {
  id: z.string().describe("The agent's id, from agent"),
  message: z.string().trim().min(1).describe("What to tell it. A finished agent restarts with it as a fresh task, keeping its context"),
  mode: z.enum(["auto", "queue", "steer"]).optional().describe("auto (default): steer a running agent, restart a finished one. queue: after its current turn. steer: mid-turn, running agents only"),
};

export const agentCancelInput = {
  id: z.string().describe("The agent's id, from agent"),
};

export const showInput = visualInput;

export const wrapUpInput = {
  summary: z.string().min(1).describe("The closing message itself, in concise markdown: the result and checks actually run. No duplicate closing text outside this tool"),
  unverified: z.string().optional().describe("Relevant behavior you did not run or check, in one sentence. Don't repeat it in summary; omit when there are no verification gaps"),
  next: z
    .array(
      z.object({
        label: z.string().min(1).max(40).describe("Short action text, 1-4 words, e.g. 'Review changes'"),
        message: z.string().min(1).describe("A full, self-contained request in the user's voice. Clicking adds it to the composer for review, not immediate execution"),
      }),
    )
    .max(3)
    .optional()
    .describe("Only useful next steps, recommendation first. Omit when the task is done and nothing needs follow-up; don't invent work or default to committing"),
};

export const TOOLS = {
  ask: {
    description:
      "Clarify and improve an underspecified request with 1-4 focused questions about the goal, scope, behavior, design or success criteria. Use it freely before edits when important choices remain; offer useful options and your recommendation. Don't repeat settled questions or ask permission for routine tool use. Free-text answers are always allowed. End your turn after calling: answers arrive as the next user message.",
    input: askInput,
  },
  show: {
    description:
      "Show a finished interactive visual inline, with an expanded view that preserves its state. Use inline HTML/CSS/SVG/JS, transparent outer background, no outer card or padding. Theme: --ink, --dim, --line, --accent, --ok, --danger, --font, --series-1 through --series-6. Local img paths are inlined; network requests are blocked. Load visualize for design guidance. Do not repeat the visual in prose.",
    input: showInput,
  },
  show_preview: {
    description: "Inspect a complex visual before show. Returns a PNG, content height, horizontal overflow and console errors in the same theme and sandbox. Use width 390 for a phone layout. Optional: skip for simple visuals. Screenshot feedback does not test interactions.",
    input: visualPreviewInput,
  },
  visualize: {
    description: "Load Tack's Visualize skill: art direction, chart and diagram design, responsive layout, interaction, animation and verification. Use for substantial visuals, not ordinary text answers.",
    input: {},
  },
  wrap_up: {
    description:
      "Close a turn that changed files, ran checks or finished multi-step work. Summary is the closing message itself; write no separate closing text before or after this last call. State what happened, checks actually run, and relevant verification gaps. Suggestions are optional and fill the composer for review; don't invent next steps. Skip for direct answers and alignment questions.",
    input: wrapUpInput,
  },
  agent: {
    description:
      "Start a sub-agent in its own inspectable thread. It gets only task, not your conversation history. Default async returns immediately; completion wakes you with its report. Keep working independently rather than polling. Use mode wait only when this turn needs its result: completion, a question or approval, or timeout returns control; timeout leaves the child running. Shared checkout by default; isolation worktree starts from HEAD without uncommitted changes. A requestKey makes retries return the same child. Returns JSON with id, threadId, generation, status, result and pending-input details. Keep id for agent_status, agent_send and agent_cancel.",
    input: agentInput,
  },
  agent_status: {
    description:
      "Read a sub-agent you started: JSON identity, generation, status, result and pending questions or approval. The id stays the same across follow-ups; supply generation to read an older result, otherwise reads the latest. Use wait true when this turn needs the result; completion or pending input returns control. Reading a terminal result acknowledges it and removes queued duplicate delivery. Otherwise let its completion wake you instead of polling.",
    input: agentStatusInput,
  },
  agent_send: {
    description:
      "Message a sub-agent you started, keeping its context. Auto steers an active turn, queues during startup or cancellation, and restarts a finished child as a new task generation. Queue waits until its current turn finishes. A question answer continues the waiting task. Returns JSON status; completion wakes you again.",
    input: agentSendInput,
  },
  agent_cancel: {
    description: "Cancel a sub-agent and its descendants, clear their queued work, and suppress automatic completion wakeups. Returns JSON status: cancelling until execution settles, then cancelled. Finished results remain readable.",
    input: agentCancelInput,
  },
} as const;

// The agent tool's description with the models this machine has, cheapest last per provider.
export function agentDescription(models: { value: string; provider: Provider }[]): string {
  const list = (p: Provider) => models.filter((m) => m.provider === p).map((m) => m.value).join(", ");
  const claude = list("claude");
  const codex = list("codex");
  const parts = [claude && `Claude: ${claude}`, codex && `Codex: ${codex}`].filter(Boolean).join("; ");
  return `${TOOLS.agent.description} Models: ${parts}. Pick cheaper ones for lookups and mapping.`;
}

export type ToolName = keyof typeof TOOLS;

export function jsonSchema(name: ToolName) {
  return z.toJSONSchema(z.object(TOOLS[name].input));
}

export type AskInput = z.infer<z.ZodObject<typeof askInput>>;
export type AgentInput = z.infer<z.ZodObject<typeof agentInput>>;
export type AgentTool = "agent" | "agent_status" | "agent_send" | "agent_cancel";
export type AgentStatusInput = z.infer<z.ZodObject<typeof agentStatusInput>>;
export type AgentSendInput = z.infer<z.ZodObject<typeof agentSendInput>>;
export type AgentCancelInput = z.infer<z.ZodObject<typeof agentCancelInput>>;

// What `ask` returns right away. Waiting inside the tool call would hit tool timeouts.
export const ASKED = "Shown to the user. End your turn now without repeating the questions; their answers arrive as the next message.";
