# Prompt completion and visual questions

The accepted prompt completion is implemented in production. The canvas uses the real production Composer for that board. Three new ask-user concepts remain interactive design previews.

| View | Preview | Behavior |
| --- | --- | --- |
| Production prompt | [Open](http://127.0.0.1:1422/?variant=ghost) | Gray text in the empty composer. Click or Tab accepts; typing or Escape dismisses. No visible Tab hint. Sending stays explicit. |
| Focus dialog | [Open](http://127.0.0.1:1422/?variant=focus) | Dims the conversation and presents illustrated alternatives together. Recommended for a visual decision. |
| Full-pane comparison | [Open](http://127.0.0.1:1422/?variant=stage) | The question owns the chat pane. A larger illustration changes with the selected option. |
| Visual inspector | [Open](http://127.0.0.1:1422/?variant=inspector) | The conversation stays readable beside a visual decision panel. Compact windows use an overlay. |

All visual concepts support keyboard selection, custom answers, explicit confirmation, and deferral without losing a selection. Completed answers appear once in the transcript. The illustrations reuse the existing Fieldwork screenshot inside an accessible SVG layout diagram; selecting an option changes the layout rather than adding decoration.

Use visual mode when seeing the tradeoff helps. Keep the compact text question for quick choices. Previous explorations, including the text-only question, are preserved under `archive/`.

## Production generation

The primary conversation model considers two or three plausible continuations internally and emits only the best grounded next prompt as private metadata on its normal final response. There is no suggestion-generation model call. New sessions no longer expose the old wrap-up tool; historical wrap-ups still render.

The sidecar strips metadata before persisting and broadcasting a completed answer. Streaming rendering masks incomplete metadata. Predictions are offered only after a successful parent turn, with all descendants, queues, questions, and approvals settled. A newer child result suppresses an earlier parent prediction until its report is integrated. Acceptance rechecks eligibility, preserves existing drafts, and never sends automatically.

## Run the design preview

From the repository root:

```sh
bun x vite build --config designs/next-steps/preview/vite.config.ts
bun x vite preview --config designs/next-steps/preview/vite.config.ts
python3 /Users/tinzeljar/.codex/skills/design/scripts/design.py start designs/next-steps
```

Both local servers are required. The canvas arranges live app views. Edit visual questions in `preview/VisualQuestion.tsx` and `preview/visual-questions.css`. Preview RPC is stubbed; illustrated-question answers do not start agents or modify projects.

## Verification

Production TypeScript and web/sidecar/native builds pass. The rebuilt macOS app passes deep code-signature verification. Temporary tests outside the repository cover 39 eligibility/prompt-policy cases and 204 completion/streaming/persistence cases, including actual Hub and Store paths for both providers.

The production Composer was exercised against a disposable transport: acceptance, explicit sending, typing/dismissal, and suppression during parent and child work. The visual concepts were checked at desktop and 760 × 480 sizes, with selection, custom answers, deferral, restored focus, and compact confirmation controls. All four canvas render checks pass. Nested canvas clicks remain limited by the browser automation; the standalone previews are the verified interactive views.

Live provider generation and prediction quality were not benchmarked. Illustrated-question concepts are not integrated into the production ask tool.
