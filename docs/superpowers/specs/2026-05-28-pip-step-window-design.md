# Document Picture-in-Picture Step Window — Design

**Status:** Approved 2026-05-28
**Author:** Tom (with Claude as collaborator)
**Feature shortlist entry:** Daily-use polish · "Document Picture-in-Picture step window"

## 1. Summary

Let learners pop the current tutorial step into a floating, always-on-top OS-level window that stays visible while they alt-tab to VS Code, BAS, or another app. Built on the [Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture). The window mirrors the tutorial step (full mode) or shrinks to a navigation controller (controller mode), staying in two-way sync with the main browser tab via `BroadcastChannel`. Chromium-only by design; silently absent on browsers that don't support the API.

This is a nice-to-have polish feature. The acceptance bar is **"adds value where supported, never breaks anything where it isn't."**

## 2. Goals & non-goals

### Goals
- Pop-out window that survives alt-tabbing and stays on top of other apps.
- Both reading and navigation work entirely from PiP — no need to bring the main tab back.
- Two-way sync of step transitions and completion clicks between main tab and PiP.
- Visual parity with the main tab's tutorial chrome (Horizon theme, dark mode mirror).
- Zero impact on browsers without Document PiP support and zero impact on existing functionality everywhere else.

### Non-goals
- Mission/group page PiP (would be a separate feature with its own design).
- Mobile (Document PiP is desktop-only by spec).
- Cross-origin / cross-tab-different-tutorial communication.
- Auto-reopen of PiP on navigation.
- Persisting PiP open state across sessions.
- Mock fallback for unsupported browsers (no `window.open`-style polyfill).

## 3. User-facing behavior

### Launch
- A "Pop out step" button appears in the U11 reading-progress bar, alongside the existing prev/next controls.
- Button only renders if `'documentPictureInPicture' in window` is true. Otherwise the U11 bar is unchanged from today.
- Click opens a Document PiP window sized 480×720 (full mode) or 480×140 (controller mode), starting in whichever mode the user used last (`localStorage`-persisted; defaults to full).

### Modes
- **Full mode:** step heading, full step body (HTML, code blocks, images), "Mark complete" button, ◀ ▶ navigation, mode-toggle chevron.
- **Controller mode:** step heading (truncated, full title in tooltip), progress dots (one per step), ◀ ▶, "Mark complete" checkbox, "Expand" button.
- Toggle via header chevron (manual, persistent) **or** automatic — when the user resizes the PiP window below ~300px tall it auto-collapses; resize larger auto-expands. Manual toggle wins over auto.

### Sync (two-way)
- Step transitions sync both directions. Advance in PiP → main tab also advances. Scroll past a step boundary in main tab (U11 scrollspy) → PiP swaps to the new step.
- Completion clicks in either window fire the `markStepComplete` API call once and propagate to the other window via the channel.
- Reading-progress UI (U11) updates in both windows.
- Within-step scrolling is independent — main tab and PiP can be scrolled to different positions inside the same step.
- Theme changes (light/dark) sync from main tab to PiP.

### Step completion
- Clicking "Mark complete" in PiP fires the API call from PiP. On success, PiP advances locally to the next step and broadcasts both `pip:complete` and `pip:stepChange`. Main tab applies them without a second API call. On API failure, PiP shows a `ui5-message-strip` error inline and does **not** advance or broadcast.
- On the final step's completion, PiP transitions to a small "Tutorial complete 🎉" panel with a close button. The user dismisses on their own terms.

### Close
- User closes PiP via OS chrome, the in-PiP close button, or by clicking the launcher button when PiP is active (the icon flips to indicate active state and the action becomes "close pop-out").
- PiP is not auto-closed on tutorial navigation. If the user navigates the main tab to a different tutorial, the old PiP persists with the old tutorial's content until manually closed.

## 4. Architecture

```
┌─────────────────── Main browser tab ───────────────────┐
│                                                        │
│  Hugo tutorial page (existing)                         │
│  ├─ U11 progress bar (existing)                        │
│  │  └─ NEW: "Pop out" launch button                    │
│  ├─ Step content DOM (untouched)                       │
│  └─ NEW: tutorial-pip-launcher Vue island              │
│                                                        │
└────────────┬───────────────────────────────────────────┘
             │ BroadcastChannel('tutorial-pip:<slug>')
             ▼
┌─────────────────── PiP window (Document PiP) ──────────┐
│                                                        │
│  Standalone <html> document created at request time    │
│  ├─ <head>: CSS cloned from main tab                   │
│  └─ <body>: NEW: tutorial-pip Vue island               │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### New code
- `hugo-apps/src/tutorial-pip-launcher/` — launcher island in the main tab.
- `hugo-apps/src/tutorial-pip/` — content island that mounts inside the PiP window.
- `hugo-apps/src/shared/pip-channel.ts` — typed `BroadcastChannel` wrapper.

### Touched code
- `hugo/layouts/partials/u11-progress-bar.html` — adds a mount node (`<div id="tutorial-pip-launcher" data-…>`) next to the existing prev/next controls.
- `hugo-apps/src/ui5-bootstrap.ts` — conditional mount of the launcher (only when feature-detected).
- `vite.config.ts` — register the two new island bundles.

### No changes
- No CAP backend changes. Completion calls reuse the existing `markStepComplete` path.
- No schema changes, no manifest changes, no Hugo template changes beyond the launcher mount node.
- No CI pipeline changes.

## 5. State ownership

| State | Owner | Notes |
|---|---|---|
| Active step index | Main tab | Source of truth; drives U11, U16, completion records |
| Completion state per step | CAP backend (cached in main tab via `getMyProgress`) | Same as today — no second cache |
| PiP mode (full / controller) | PiP window, mirrored to `localStorage` on each change | User preference |
| PiP open/closed | Launcher island in main tab | Holds the `Window` reference |
| Steps array (heading, body, slug) | Hugo-emitted JSON in the main tab DOM | Already exists for U11/U16; passed to PiP at launch via `pip:init` |
| Theme (light/dark) | Main tab `<html data-theme>` | Mirrored to PiP via `pip:themeChange` |

## 6. Message contract

Channel: `BroadcastChannel('tutorial-pip:<slug>')`.

```ts
type PipMessage =
  | { type: 'pip:init';        steps: StepPayload[]; activeStep: number; mode: 'full'|'controller' }
  | { type: 'pip:hello' }      // launcher mount handshake
  | { type: 'pip:reattach' }   // PiP response to hello
  | { type: 'pip:stepChange';  stepIndex: number }
  | { type: 'pip:complete';    stepIndex: number }
  | { type: 'pip:modeChange';  mode: 'full'|'controller' }
  | { type: 'pip:themeChange'; theme: 'light'|'dark' }
  | { type: 'pip:closed' };
```

Every message also carries `senderId: string` (a `crypto.randomUUID()` minted per `createPipChannel(...)` call) and `source: 'main'|'pip'`. Each window drops messages where `senderId === ourId` to prevent self-broadcasts.

Loop prevention: when a window receives a remote message, it applies the change but does **not** re-broadcast. Only user-driven changes broadcast.

## 7. Components

### `tutorial-pip-launcher/` (main tab)
```
tutorial-pip-launcher/
├── index.ts              feature-detected mount entry
├── Launcher.vue          renders the button + manages PiP window
└── usePipLifecycle.ts    open/close, channel wiring, css cloning
```

`Launcher.vue` props: `slug`, `steps`, `activeStepIndex`. Internal state: `pipWindow: Window | null`. The button has two states (idle / active). Clicking when active calls `pipWindow.close()`.

### `tutorial-pip/` (PiP window)
```
tutorial-pip/
├── index.ts                mount entry called by launcher
├── PipShell.vue            owns mode + step state, channel subscription
├── FullMode.vue            heading + body + Mark Complete + ◀ ▶ + chevron
├── ControllerMode.vue      heading + ◀ ▶ + dots + Mark Complete + Expand
└── useStepNavigation.ts    prev/next/goto + completion API
```

Both mode components emit `next`, `prev`, `goto(stepIndex)`, `complete(stepIndex)`, `toggleMode`. `PipShell` handles them, calls the composable, broadcasts.

Why one island with mode-switch (not two): mode change keeps the channel subscription stable and the `localStorage` preference and active-step state are shared.

### `shared/pip-channel.ts`
```ts
export function createPipChannel(slug: string, source: 'main'|'pip') {
  const channel = new BroadcastChannel(`tutorial-pip:${slug}`);
  const senderId = crypto.randomUUID();
  return {
    send(msg: PipMessage): void,
    on(handler: (msg: PipMessage) => void): () => void,
    close(): void,
  };
}
```

Auto-stamps `senderId` and `source` on every send. Drops self-messages on receive.

## 8. Lifecycle (happy path)

1. **Launcher mounts.** Feature-detects API; if absent, renders nothing. Otherwise reads `slug`, `steps`, `activeStepIndex` from mount node `data-*` attrs. Subscribes to `BroadcastChannel`. Sends `pip:hello`. (Useful only for orphan-window recovery — see §9.)

2. **User clicks "Pop out".** `await documentPictureInPicture.requestWindow({ width: 480, height: mode === 'full' ? 720 : 140 })`. Clones stylesheets and `<link rel="preconnect|stylesheet">` for fonts into `pipWindow.document.head`. Copies `<html data-theme>`. Mounts `tutorial-pip` Vue island. Sends `pip:init`.

3. **PiP receives `pip:init`.** Hydrates active step + mode. Subscribes to channel. Wires its own ResizeObserver for the auto-collapse threshold.

4. **User clicks Next in PiP.** PiP broadcasts `pip:stepChange`. Launcher receives, calls the same `goToStep(idx)` helper U16/U11 use. Main tab re-renders normally.

5. **User scrolls past a step boundary in main tab.** U11's existing `tutorial:step-change` DOM event fires. Launcher debounces (~150ms) and broadcasts `pip:stepChange`. PiP receives, swaps step.

6. **User clicks "Mark complete" in PiP.** PiP calls `markStepComplete(slug, idx)`. On 2xx, broadcasts `pip:complete` then `pip:stepChange` (idx+1). On error, shows inline `ui5-message-strip` and does nothing else.

7. **User toggles mode in PiP.** Writes mode to `localStorage`. Re-renders. Broadcasts `pip:modeChange` (informational).

8. **User toggles theme in main tab.** MutationObserver on `<html data-theme>` fires. Launcher broadcasts `pip:themeChange`. PiP applies the theme to its own `<html>`.

9. **User closes PiP.** PiP's `pagehide` listener fires `pip:closed`. Launcher clears its window reference. Button returns to idle.

## 9. Error handling

| Scenario | Handling |
|---|---|
| `requestWindow()` rejects (gesture / policy / private mode) | Single `ui5-toast` warning. Button stays enabled for retry. No modal. |
| API removed mid-session via experimental flag | Runtime check inside click handler. Toast + early return. |
| Main tab reloads while PiP is open | Launcher mounts fresh, sends `pip:hello`. Live PiP responds with `pip:reattach`. Launcher takes over orphan window. If browser closed PiP on reload, no response — launcher silently no-ops. |
| Main tab navigates to different tutorial | Old PiP persists with old content. New tutorial's launcher uses a different per-slug channel name; no cross-talk. User closes old PiP manually. |
| `markStepComplete` fails inside PiP | Inline `ui5-message-strip` in PiP body. No advance. No broadcast. Main tab's progress untouched. |
| Channel message with out-of-range step | Bounds check in both islands. Console.warn + drop. |
| Two main tabs on same tutorial both open PiP | Per-instance `senderId` drops self-broadcasts. Genuine cross-tab cross-talk is a known minor gap (accepted). |
| Channel arrives with wrong `senderId` (self-loop) | Dropped at receive. |
| User opens dev-tools / view-source / print on PiP | Whatever browser does. Out of scope. |

## 10. Browser compatibility

- **Supported:** Chromium ≥ 116 (Chrome, Edge, Opera, Brave). Launcher renders, PiP works fully.
- **Unsupported:** Firefox, Safari, older Chromium, mobile. Launcher's `index.ts` exits before mounting Vue. The U11 bar renders unchanged. Zero new DOM, zero new bytes shipped (the bundled island JS is loaded but never instantiates a component).
- **Detection:** `'documentPictureInPicture' in window` checked at island mount time, before Vue is instantiated.

## 11. Security

- PiP window is same-origin (created via Document PiP, not a cross-origin `window.open`). Cookies, auth, fetch helpers inherit transparently.
- Step bodies rendered with `v-html` in PiP — same as the main tab, same sanitization (Hugo build-time `sanitize-html.ts`). No new XSS surface.
- CSP unchanged; PiP inherits opener's policy.
- Stylesheets cloned by node-clone, not URL re-fetch — no new network surface.

## 12. Testing

**Approach: minimal, focused, no new pipelines.** This is a polish feature on a Chromium-only API. Adding Playwright would be over-engineering for the value delivered.

### Unit (Vitest, in-memory) — `test/unit/pip/`
- `pip-channel.spec.ts` — round-trip messages, auto-stamping, self-broadcast drop, close hygiene.
- `Launcher.spec.ts` — feature detection (no DOM when API missing); request → window stored; rejection → toast + no reference.
- `PipShell.spec.ts` — `pip:init` hydration; mode toggle persists to `localStorage`; received `pip:stepChange` updates without re-broadcast; user-driven changes broadcast with correct `source`.
- `useStepNavigation.spec.ts` — completion success advances + broadcasts; failure surfaces error + no advance + no broadcast.
- `FullMode.spec.ts` / `ControllerMode.spec.ts` — render with given step + steps; emit correct events; render mode-correct elements.

`BroadcastChannel` and `documentPictureInPicture` are mocked via small fixtures in `test/unit/pip/_helpers/`.

### Hybrid — no new tests
PiP doesn't touch HANA. The completion path it uses is the same one already covered by hybrid tests for the main tab.

### Smoke — one new check
Add to existing static-content smoke: assert `/js/tutorial-pip-launcher.<hash>.js` and `/js/tutorial-pip.<hash>.js` are present and 200. Catches the build regression where a new island silently drops out of the bundle.

### Manual verification (Tom)
- Open a multi-step tutorial in Chrome. Click pop-out. Step content visible in floating window.
- Alt-tab to another app. PiP stays on top.
- Click Next in PiP. Main tab advances. Click Next in main tab. PiP advances.
- Mark step complete in PiP. Toast in PiP, dot fills in main tab's U11 bar.
- Toggle dark mode in main tab. PiP flips theme.
- Resize PiP window very small. Auto-collapses to controller mode.
- Open Firefox. Tutorial page renders normally — no launch button.

### Don't-break-existing-things checklist
- Run full unit suite: `npm test` — must pass with no regressions.
- Run hybrid suite once on DEV: `npm run test:hybrid` — must pass with no regressions.
- Smoke against deployed: `npm run test:smoke` — must pass with no regressions.
- Visual check: open a tutorial in Firefox, confirm U11 bar looks identical to before.

## 13. Open questions / accepted gaps

- **Cross-tab same-tutorial collision** (two main tabs on same slug, both with PiP open) — `senderId` drops self-broadcasts but cross-tab messages still cross. Accepted as known minor gap; symptom is harmless (steps stay in sync across all four windows, which is arguably correct).
- **OS-level window manager interactions** (snap, multi-monitor, fullscreen) — out of scope; relies on browser/OS behavior.
- **Performance benchmarks** — not a target metric.

## 14. Dependencies

- No new runtime dependencies. Document PiP API is native browser. `BroadcastChannel` is native. Vue, UI5 web components already in project.
- No new build dependencies.
- No new CI dependencies.

## 15. Rollout

1. Feature ships behind no flag — silent feature-detect handles non-supporting browsers.
2. Manual smoke by Tom in Chrome/Edge after deploy.
3. If we want a kill switch in case of unexpected fallout, the launcher mount call in `ui5-bootstrap.ts` is gated by a one-line check; we can add a `?nopip=1` URL escape hatch if needed (decided at implementation time, not specified here).
4. Document in [docs/end-users/](../../end-users/) — one paragraph in the tutorial reading guide.
