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

Open the browser with the globe icon or `⌘⇧B`. You and the agent share isolated Chromium tabs: click, type, paste, and scroll in the pane, or ask Claude or Codex to inspect and test the same page. In Full access, first use downloads Chromium automatically.

Drag the divider to resize the actual page viewport. The browser can grow across most of the workspace; Expand fills it. Clicking the page gives you control until you return to the chat, so agent actions cannot interfere with your input.

The pen captures the current page for drawing. Drawing controls appear after your first mark. **Add to chat** attaches the annotated PNG to your existing draft; send it normally to the model.

## Computer use

Claude and Codex share Tack's Cua Driver tools for native Mac apps. Ask for the task; in Full access, Tack opens the needed apps automatically. Work stays in the background whenever possible, with a separate agent cursor that leaves your mouse alone. The agent can bring a window forward when needed without asking. Apps that require the system pointer may remain unsupported. Web and Chrome tasks use the built-in sidebar browser. Ask mode keeps app approvals. First use opens macOS permission setup, then continues when permission is granted. The monitor icon and chat Stop end control and revoke access. Finishing a turn stops the native runtime. Apps remain open.

## Mobile devices

Open Devices with the phone icon or `⌘⇧D`, or ask the agent to test an iOS or Android app. Tack chooses an installed simulator or emulator, boots it in the background, and shows an interactive screen in the sidebar. You and the agent can tap, swipe, type, and navigate there without using your Mac mouse. Closing the preview releases control; devices keep running until explicitly shut down or Tack exits. Tack only shuts down devices it booted itself.

Device support uses Expo Device Hub and agent-device, pinned to the versions used by T3 Code. First use prepares their runtime automatically. The Mac needs Node.js 22.12+, npm, and the relevant Xcode or Android SDK runtimes.

Grant Tack Accessibility and Screen Recording permission on first use, then restart Tack. Desktop input stays in the background. App access is separate from the full-access setting. Web testing continues to use Tack's isolated browser.

The build downloads a checksum-pinned, MIT-licensed Cua Driver runtime and bundles it with its notices. No separate Cua installation, API key, account, or agent is needed. Cua telemetry and automatic update checks are disabled.

## How it works

- **One process per active thread:** each thread keeps a `claude` process warm. Idle ones close after 15 minutes and resume the same session on the next message.
- **Coalesced streaming:** streaming text is merged in memory and sent to the UI at most every 33 ms. Only finished items are written to disk, one JSONL line each.
- **Light UI:** the transcript is virtualized, and only the row that is streaming re-renders.
- **Queue and steer:** while an agent works, `↵` steers the current run and `⌘↵` queues a message for afterward. Follow-ups wait safely during startup, compaction, or other gaps when the provider cannot accept them. `Esc` stops the agent and holds queued messages until you resume or send again.
- **Sub-agents:** Claude and Codex can delegate fresh tasks, including nested work, and send follow-ups without losing context. Tasks, results, queued messages, and delivery acknowledgments survive restart. Work interrupted by restart remains inspectable and can be continued with a follow-up.
- **Agent workspaces:** children share their parent's checkout by default. Optional worktree isolation starts a separate branch from the parent's committed `HEAD`; completed worktrees remain available to inspect.
- **Agent controls:** waits return for completion, a question, an approval, or timeout. Stop cancels descendant work and suppresses automatic completion wakeups. Questions and approvals can be answered from either the parent or child view.
- **Permissions:** full access by default. "Ask first" prompts for each tool call your Claude settings don't already allow.
