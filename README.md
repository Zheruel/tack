# Tack

A lean, fast, local desktop harness for coding agents. It runs Claude Code and Codex on your existing plans.

## Principles

- Local development only. No cloud, accounts or telemetry.
- Cut the fat: no feature ships unless people actually use it to code with agents.
- Lean context: start from the default Claude Code and Codex prompts, then strip whatever hurts quality or speed.
- Speed comes first.

## Stack

| Part | What | Where |
| --- | --- | --- |
| Shell | Tauri 2, a thin Rust layer: window, dialogs, sidecar launch | `src-tauri/` |
| Sidecar | Bun, WebSocket server, SQLite + JSONL transcripts, agent sessions | `server/` |
| UI | React 19 with the compiler, Vite, Tailwind v4, Streamdown | `web/` |
| Protocol | Typed requests and events shared by UI and sidecar | `shared/protocol.ts` |

Claude runs through the official `claude` binary (Agent SDK), so it uses your Claude login. macOS only for now.

## Develop

Requires [Bun](https://bun.sh), [Rust](https://rustup.rs) and the `claude` CLI, logged in.

```bash
bun install
bun run dev          # the desktop app, with hot reload for the UI
```

Work on the UI in a browser instead:

```bash
TACK_DEV=1 TACK_PORT=7357 bun run dev:server
bun run dev:web      # http://localhost:1420
```

Build the app with `bun run build`. The bundle lands in `src-tauri/target/release/bundle/`.

## Browser

Open the browser with the globe icon or `⌘⇧B`. You and the agent share isolated Chromium tabs: click, type, paste, and scroll in the pane, or ask Claude or Codex to inspect and test the same page. First use offers a one-time browser download.

Drag the divider to resize the actual page viewport. The browser can grow across most of the workspace; Expand fills it. Clicking the page gives you control until you return to the chat, so agent actions cannot interfere with your input.

The pen captures the current page for drawing. Drawing controls appear after your first mark. **Add to chat** attaches the annotated PNG to your existing draft; send it normally to the model.

## How it works

- **One process per active thread:** each thread keeps a `claude` process warm. Idle ones close after 15 minutes and resume the same session on the next message.
- **Coalesced streaming:** streaming text is merged in memory and sent to the UI at most every 33 ms. Only finished items are written to disk, one JSONL line each.
- **Light UI:** the transcript is virtualized, and only the row that is streaming re-renders.
- **Queue and steer:** while an agent works, `↵` steers the current run and `⌘↵` queues a message for afterward. Follow-ups wait safely during startup, compaction, or other gaps when the provider cannot accept them. `Esc` stops the agent and holds queued messages until you resume or send again.
- **Sub-agents:** Claude and Codex can delegate fresh tasks, including nested work, and send follow-ups without losing context. Tasks, results, queued messages, and delivery acknowledgments survive restart. Work interrupted by restart remains inspectable and can be continued with a follow-up.
- **Agent workspaces:** children share their parent's checkout by default. Optional worktree isolation starts a separate branch from the parent's committed `HEAD`; completed worktrees remain available to inspect.
- **Agent controls:** waits return for completion, a question, an approval, or timeout. Stop cancels descendant work and suppresses automatic completion wakeups. Questions and approvals can be answered from either the parent or child view.
- **Permissions:** full access by default. "Ask first" prompts for each tool call your Claude settings don't already allow.
