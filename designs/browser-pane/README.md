# Tack browser concept

Open the local Design canvas and use Play to try the four views: shared workspace, empty, closed, and compact.

The artboards embed Tack's actual React app. Edit the pane in `web/src/components/BrowserPane.tsx` and its styles in `web/src/styles.css`. The canvas State tweak changes the starting view. The separate local app server must remain running; portable canvas export does not include it.

The browser occupies the full height beside the chat header, with no bottom bar. Its only page tool is a pen. Draw on a snapshot, undo strokes, then choose **Add to chat** to attach the marked PNG alongside the current draft. The composer sends it through the existing image attachment flow. Drawing freezes the captured page until you attach or discard it.

The preview uses a design-only RPC transport and static sample page. It never sends messages or touches the user's projects. Production Tack streams the shared Chromium page, supports pointer/keyboard/paste/scroll input and responsive viewport resizing, and captures PNGs for annotations and model inspection. The canvas remains a visual prototype; run the app to browse real pages.

From the repository root:

```sh
bun x vite build --config designs/browser-pane/preview/vite.config.ts
bun x vite preview --config designs/browser-pane/preview/vite.config.ts
python3 /Users/tinzeljar/.codex/skills/design/scripts/design.py start designs/browser-pane
```

The app preview listens on `http://127.0.0.1:1421/`. The design helper prints the canvas URL. Review captures are in `review/`.

Verification includes real Claude and Codex tool use with iframe controls and image attachments, 64 backend/RPC checks, 45 wide viewport/capture checks, first-run installation from compiled Bun, frontend input/image-message tests, and the packaged macOS app. The original code's T3 provenance cannot be established; the live viewer and frame-aware refs follow the inspected T3 approach. The local app build is unsigned.
