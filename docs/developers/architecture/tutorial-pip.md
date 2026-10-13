# Tutorial Picture-in-Picture (PiP) step window

The chevron button in the tutorial Steps header (icon `navigation-up-arrow`, tooltip
**"Pop out current step"**) opens the **Tutorial Picture-in-Picture window** — a
floating, always-on-top OS-level window that mirrors the current tutorial step so
learners can keep it visible while alt-tabbing to VS Code, BAS, or another app.

Built on the Chromium [Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture).
It is a polish feature: **adds value where supported, never breaks anything where it
isn't.** On browsers without the API (Firefox, Safari, older Chromium, mobile) the
launcher never mounts and the page is unchanged.

Original design: [docs/superpowers/specs/2026-05-28-pip-step-window-design.md](../../superpowers/specs/2026-05-28-pip-step-window-design.md)
· plan: [docs/superpowers/plans/2026-05-28-pip-step-window.md](../../superpowers/plans/2026-05-28-pip-step-window.md).

## User-facing behavior

- **Launch** — chevron button next to the step-progress bar on the Steps tab.
  Renders only when `'documentPictureInPicture' in window` is true. Icon flips to
  `navigation-down-arrow` (tooltip "Close pop-out window") while the window is open;
  clicking again closes it.
- **Two modes**, toggled by the in-window chevron (`⌄`/`⌃`) or automatically when the
  window is resized across the ~300px-tall threshold (manual toggle wins):
  - **Full mode** — step heading, full step body (HTML, code, images), Mark Complete,
    ◀ ▶ navigation.
  - **Controller mode** — truncated heading, progress dots, ◀ ▶, Mark Complete, Expand.
- **Two-way sync** over `BroadcastChannel('tutorial-pip:<slug>')`: step transitions and
  completion clicks propagate both directions; main-tab scrollspy step changes swap the
  PiP step; main-tab theme (light/dark) mirrors into PiP. Within-step scroll is
  independent.
- **Completion** — Mark Complete in PiP fires `markStepComplete` once from PiP, then
  broadcasts; the main tab applies it without a second API call. On API failure PiP shows
  an inline `ui5-message-strip` and does not advance. Final-step completion shows a
  "Tutorial complete 🎉" panel.
- **Close** — OS chrome, the in-window close button, or the launcher button. PiP is
  **not** auto-closed on navigation; a stale PiP persists with the old tutorial until
  closed manually (new tutorial uses a different per-slug channel, so no cross-talk).

## Where it mounts

Both tutorial layouts render the launcher mount node + script, gated by QA/preview rules:

- `hugo/layouts/tutorials/u1-object-page.html:390` (current Object Page layout) and
  `:520` (script).
- `hugo/layouts/tutorials/single.html:28` / `:54` (legacy layout).

```html
<div id="tutorial-pip-launcher" data-slug="…" data-active-step="1"
     data-pip-src="{{ partial "island-src.html" "tutorial-pip" }}"></div>
```

`data-pip-src` carries the content-hashed URL of the `tutorial-pip` island, which the
launcher injects into the PiP document on demand — the PiP island is not loaded until the
window opens.

## Code map

| Path | Role |
|---|---|
| `hugo-apps/src/tutorial-pip-launcher/main.ts` | Entry. Feature-detects (`isPipSupported`), reads steps from the `.tutorial-step[data-step]` DOM, mounts `Launcher` on an idle frame. |
| `hugo-apps/src/tutorial-pip-launcher/Launcher.vue` | The chevron `ui5-button` + the "pop-out blocked" `ui5-toast`. |
| `hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.ts` | `requestWindow`, CSS/theme cloning into the PiP document, channel wiring, `isPipSupported`. |
| `hugo-apps/src/tutorial-pip/main.ts` | Mount entry run inside the PiP window. |
| `hugo-apps/src/tutorial-pip/PipShell.vue` | Owns mode + active-step state, channel subscription, ResizeObserver auto-collapse. |
| `hugo-apps/src/tutorial-pip/FullMode.vue` / `ControllerMode.vue` | The two layouts. |
| `hugo-apps/src/tutorial-pip/useStepNavigation.ts` | prev/next/goto + completion API call. |
| `hugo-apps/src/shared/pip-channel.ts` | Typed `BroadcastChannel` wrapper; stamps `senderId`/`source`, drops self-messages. |
| `hugo-apps/src/shared/pip-storage.ts` | `localStorage` persistence of the chosen mode. |
| `hugo-apps/src/shared/pip-types.ts` | `StepPayload`, `PipMode`, `PipMessage` message contract. |

Both islands are registered as Vite entries in `hugo-apps/vite.config.ts`
(`tutorial-pip-launcher`, `tutorial-pip`).

## Message contract

`BroadcastChannel('tutorial-pip:<slug>')`, messages typed in `pip-types.ts`:
`pip:init`, `pip:hello`, `pip:reattach`, `pip:stepChange`, `pip:complete`,
`pip:modeChange`, `pip:themeChange`, `pip:closed`. Every message carries a per-instance
`senderId` (`crypto.randomUUID()`) and `source: 'main'|'pip'`; a window drops any message
it sent itself. Received changes are applied but **not** re-broadcast — only user-driven
changes broadcast.

## Scope & gotchas

- **Chromium ≥ 116 only** (Chrome, Edge, Opera, Brave). Detection runs before Vue
  instantiates; unsupported browsers ship the bundle but never mount a component.
- **No CAP/backend/schema/CI changes** — completion reuses the existing `markStepComplete`
  path.
- **QA / preview channels suppress the launcher** — the `u1-object-page.html` mount is
  gated by `not site.Params.qa` and `not site.Params.previewMode`.
- **Steps are read from the rendered DOM** (`.tutorial-step[data-step]` →
  `.step-title-text` / `.step-content`), not from a JSON payload — if those classes change
  in the Object Page template, the PiP body goes empty.
- **Smoke coverage**: the deployed-content smoke asserts both island bundles
  (`tutorial-pip-launcher.<hash>.js`, `tutorial-pip.<hash>.js`) are present and return 200,
  catching a bundle drop-out.

## Tests

Unit (Vitest), co-located next to source:
`hugo-apps/src/shared/pip-channel.test.ts`, `pip-storage.test.ts`,
`hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.test.ts`,
`hugo-apps/src/tutorial-pip/useStepNavigation.test.ts`.
`BroadcastChannel` and `documentPictureInPicture` are mocked.
