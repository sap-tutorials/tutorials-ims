# "Wow, browsers can do that?" — Feature Shortlist

Working backlog of end-user-facing capabilities for the tutorial platform. Each entry is a candidate for its own brainstorm → spec → plan cycle.

Ordering reflects rough impact/effort, not commitment. First pick: **Document PiP step window** (in-flight as of 2026-05-28).

## Capability shocks

- **WebContainers — run `cds watch` in the page.** Boot real Node.js + npm in-browser via [webcontainers.io](https://webcontainers.io). "Try it live" CAP projects with file tree and terminal, zero install. Biggest single behavior change for a CAP tutorial site.
- **wa-sqlite — real SQL in code blocks.** WASM SQLite seeded with sample data. "Try this query" becomes interactive instead of copy-paste.

## Daily-use polish

- **Document Picture-in-Picture step window.** Pop the current tutorial step into a floating, always-on-top OS-level window that stays visible while the learner alt-tabs to VS Code / BAS. ([Document PiP API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).) **← in design**
- **View Transitions API for step navigation.** Native cinematic morphs between steps (heading flies into place, code crossfades). No library.
- **Scroll-driven animations.** Pure CSS `animation-timeline: view()`. Hero diagrams assemble themselves as you scroll.
- **Wake Lock + ambient reader mode.** Keep the screen on during long tutorials, dim chrome. Pairs with shipped U12 reader mode.

## Co-presence

- **"Pair through this with me."** WebRTC screenshare + voice + synced step pointer, launched from any step. No Zoom needed.

## Sensory / accessibility

- **Eye-tracking auto-scroll.** Webcam + face-api.js / MediaPipe — the page scrolls when gaze nears the bottom. Niche but striking.
- **Hand-gesture step navigation.** MediaPipe Hands — air-swipe to advance. Best as a kiosk / event-booth demo.

---

Items not yet shortlisted but on the table for later: live cursors on tutorial steps, on-device LLM via transformers.js, Web Serial firmware flashing, Shape Detection API for QR, WebXR mission map, Web Speech voice control.
