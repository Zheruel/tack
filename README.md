# Tack

A lean, fast, local desktop harness for coding agents. It runs Claude Code and Codex on your existing plans.

## Principles

- Local development only. No cloud, accounts or telemetry.
- Cut the fat: no feature ships unless people actually use it to code with agents.
- Lean context: start from the default Claude Code and Codex prompts, then strip whatever hurts quality or speed.
- Speed comes first.

## Stack

- macOS only, for now
- Tauri 2 shell (thin Rust layer: window, menus, PTY)
- Bun sidecar (agents, SQLite, git), connected to the UI over a WebSocket
- Claude through the official `claude` binary; Codex through `codex app-server`

## Status

Pre-alpha. Still being scoped.
