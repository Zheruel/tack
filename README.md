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

## How it works

- **One process per active thread:** each thread keeps a `claude` process warm. Idle ones close after 15 minutes and resume the same session on the next message.
- **Coalesced streaming:** streaming text is merged in memory and sent to the UI at most every 33 ms. Only finished items are written to disk, one JSONL line each.
- **Light UI:** the transcript is virtualized, and only the row that is streaming re-renders.
- **Queue and steer:** while an agent works, press `↵` to queue a message or `⌘↵` to interrupt and send it now. `Esc` stops the agent.
- **Permissions:** full access by default. "Ask first" prompts for each tool call your Claude settings don't already allow.
