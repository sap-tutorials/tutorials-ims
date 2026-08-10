# BAIP Trial — Embedded / Hosted Tutorial Mode

**Issue:** [sap-tutorials/tutorials-ims#1584](https://github.com/sap-tutorials/tutorials-ims/issues/1584) — "New Development for BAIP Trial Prototype"
**Date:** 2026-08-10
**Status:** Design approved; ready for implementation plan

## Goal

Let an external application (the **Business AI Platform (BAIP) Trial** experience, shown at TechEd) *host* a developers.sap.com tutorial inside a side window or panel and force it into a stripped-down "minimize" mode. From the issue:

> Add new URL Parameter to force Reader Mode. Add new URL Parameter to set no header or customized header bar with reduced navigation options. This way an application could "host" a tutorial in a side window and force it into this minimize mode.

The host may embed the tutorial via an **iframe** OR open it in a **separate browser window** — the URL parameters must work identically for both.

## What already exists (reuse, don't rebuild)

The recon of the codebase found two directly-relevant features already shipped:

1. **Reader / focus mode (U12).** A single attribute `html[data-reader="on"]` drives a CSS cascade in `hugo/assets/css/ui5-overrides.css` (lines ~280–345) that hides the right rail, breadcrumbs, feedback-share, step-controls, sticky stepnav, footer, and Joule, dims the site shellbar to `opacity:0.4`, collapses the two-column grid, and enlarges type. It is persisted to `localStorage['reader']` and re-applied before first paint by an inline script in `hugo/layouts/partials/head.html` (lines ~46–53). Today it is triggered **only** by pressing the `f` key — there is no URL param and no visible button.
2. **Picture-in-Picture side window.** `hugo/static/js/tutorial-pip*.js` (source: `hugo-apps/src/tutorial-pip*`) uses the `documentPictureInPicture` API to pop tutorial steps into a floating always-on-top window with "full" and "controller" modes, wired over a channel to the main page. It already listens to `tutorial:step-change` / `tutorial:step-completed` events and no-ops when the API is unsupported.

Also confirmed:
- **Framing already permitted.** `approuter/xs-app.json` sends `Content-Security-Policy: … frame-ancestors 'self' https://*.sap.com https://*.sap.cn https://*.cloud.sap …` and sends **no** `X-Frame-Options`. So an iframe host on a `*.sap.com` / `*.cloud.sap` origin works today with **zero header changes**. (Action item: confirm BAIP's trial origin is within that allow-list; if not, add it to the CSP.)
- **Server serves identical HTML per slug regardless of query string.** `srv/lib/content-store.js` `serveHandler` does not inspect query params (only preserves them on 301 redirects) and its cache is slug-keyed. Therefore **all embed behavior must be client-side**, and `?embed=…` will not fragment the content cache. No server change is needed for the core feature.

## Decisions (from brainstorming)

- **Hosting model:** support **both** iframe and standalone window; params are purely client-side so they work either way.
- **Behaviors in scope:** no header, minimal/custom header, force reader mode, auto-launch PiP.
- **Persistence:** persisted to `localStorage` (like reader mode) — with an always-available escape hatch so a user can never get trapped in a chrome-less state.
- **Host messaging:** include a `postMessage` bridge (bidirectional) so the host can react to progress and drive the tutorial.
- **Architecture:** **Approach A — single `embed` param with named presets** (rejected: composable per-chrome flags = combinatorial CSS/YAGNI; server-rendered variant = touches cache keys + breaks iframe/window parity).
- **Extras folded into scope:** `?step=N` deep-link, `?host=1` shorthand, narrow-frame auto-compact, DB-driven host-origin allowlist (heaviest — may be phased).

## The host-facing contract (URL params)

| Param | Values | Effect |
|---|---|---|
| `embed` | `none` | Hide site shellbar, footer, breadcrumbs, right rail, Joule, alerts popover, command palette, reading-progress bar. Bare content. |
| `embed` | `minimal` | Hide the real `ui5-shellbar`; render a slim embed bar instead (SAP mark + tutorial title + step progress + theme toggle). No global nav / search / share / profile / login. |
| `embed` | `reader` | Force the existing reader mode (equivalent to pressing `f`). |
| `embed` | `full` | Explicit reset — clears the embed attribute **and** the persisted `localStorage` key. The escape hatch target. |
| `pip` | `1` | Auto-launch the existing Picture-in-Picture window on load. Orthogonal — combinable with any `embed` value. |
| `step` | `N` (integer) | Open/scroll the tutorial to step N on load (reuses the existing goto path). |
| `host` | `1` | Shorthand preset = `embed=minimal` + `pip=1`. The flagship "hosted side window" one-liner for BAIP. |
| `host-origin` | URL | The host's exact origin, used as the `postMessage` target and inbound-origin filter. Validated against the allow-list. |

## State model

Mirror the proven `data-reader` pattern:

- A single attribute `html[data-embed="none|minimal|reader"]`, set by the **pre-paint script in `head.html`** before first paint (no chrome flash).
- **Precedence** (evaluated in the pre-paint script): URL `embed`/`host` param wins → else persisted `localStorage['embed']` → else no attribute.
- `embed=full` deletes both the attribute and `localStorage['embed']`.
- **Validation:** allow-list the string values (`none|minimal|reader|full`), reusing the validation shape of `app/explore/src/focus-param.ts`. Any unrecognized value is ignored (treated as `full`).
- `host=1` expands to `embed=minimal` + `pip=1` during param resolution.
- `pip=1` is handled by the existing PiP launcher (already no-ops when `documentPictureInPicture` is unsupported).

### Escape hatch (safety for the persist decision)

When `data-embed="none"`, render a small fixed-position **"⤢ Open full site" pill** (bottom-right). It links to the current path with `?embed=full`, opening in a new tab/top-level context so a framed user escapes the frame. This guarantees a persisted chrome-less state can never trap a user without navigation. `embed=minimal` already exposes the SAP mark as a full-site link, so the pill is only required for `none`.

## CSS

Almost no new CSS for `none`/`reader` — extend the existing reader cascade in `ui5-overrides.css`:

- Make the reader selectors also match `[data-embed="reader"]` (alias).
- `[data-embed="none"]` → same hides as reader **plus** `display:none` on `ui5-shellbar` (reader only dims it) and the reading-progress bar.
- **Relax the `[data-page-kind="tutorial"]` gate** for the embed selectors so a hosted *mission* or *concept* page also strips (hosting is general, not tutorial-only). Reader mode's existing tutorial-only scoping is unchanged.

`embed=minimal` is the only genuinely new UI:

- **New partial `hugo/layouts/partials/embed-bar.html`** — a ~44px slim bar: SAP logo (full-site link, new tab), truncated tutorial title, step progress ("Step 3 of 8", reusing existing progress data attributes), theme toggle (reusing the existing `toggleTheme` logic). No auth, nav, search, or share.
- Rendered from `baseof.html` only when the embed mode requires it. The real `ui5-shellbar` is hidden by CSS under `[data-embed="minimal"]`.
- Uses the same Horizon tokens; dark mode and the existing pre-paint theme logic are untouched.

## postMessage bridge

New module `hugo/assets/js/embed-bridge.ts` (built like other TS islands). Loaded **only** when the page is framed (`window.parent !== window`) or opened with an `embed`/`pip`/`host` param; otherwise completely inert (never attaches listeners) — zero impact on normal visitors. It is a thin adapter over events the tutorial runtime already dispatches (`tutorial:step-change`, `tutorial:step-completed`).

**Outbound (tutorial → host)** via `window.parent.postMessage` (iframe) and `window.opener?.postMessage` (window):

| `type` | Payload | When |
|---|---|---|
| `sap:tutorial:ready` | `{ slug, title, stepCount }` | Once, on load |
| `sap:tutorial:step-change` | `{ slug, stepIndex }` | Active step changes |
| `sap:tutorial:step-completed` | `{ slug, stepIndex }` | A step is marked complete |
| `sap:tutorial:completed` | `{ slug }` | Last step finished |

**Inbound (host → tutorial)** via a `message` listener:

| `type` | Payload | Effect |
|---|---|---|
| `sap:tutorial:goto` | `{ stepIndex }` | Scroll to / open that step |
| `sap:tutorial:set-embed` | `{ mode }` | Change embed mode live |
| `sap:tutorial:set-theme` | `{ theme }` | light / dark |

**Security (load-bearing):**

- Outbound posts target a **specific origin**, never `*`. The target is `host-origin` (when supplied and valid) or is derived/validated against the allow-list.
- The allow-list defaults to the same `*.sap.com` / `*.sap.cn` / `*.cloud.sap` family already in the approuter CSP.
- The inbound listener **validates `event.origin`** against the allow-list and ignores anything else.
- Messages are namespaced `sap:tutorial:*` to avoid collision with unrelated `postMessage` traffic.

### DB-driven origin allow-list (in scope; may be phased)

Rather than hardcoding the origin allow-list, model it as an admin-editable config entity (consistent with the project preference for DB-driven config over env vars). The bridge fetches the allow-list from a small public endpoint (or it is baked into the served page). **Phasing note:** to keep the core POC deliverable small, implementation may start with a hardcoded allow-list constant and swap in the DB-driven source as a follow-up task within this change — the bridge's origin-check interface stays identical either way.

## Extras (in scope)

1. **`?step=N` deep-link** — resolve after the tutorial runtime is ready; reuse the existing goto/scroll path. Validate N against step count.
2. **`?host=1` shorthand** — expands to `embed=minimal&pip=1` during param resolution.
3. **Narrow-frame auto-compact** — when framed and viewport width is below a threshold, auto-prefer `minimal` (and optionally PiP). Must not override an explicit `embed`/`host` param. Guard against surprising the demo: threshold chosen conservatively and documented.

## Files

| File | Change |
|---|---|
| `hugo/layouts/partials/head.html` | Pre-paint: parse + validate `embed`/`host`/`step` params, set `html[data-embed]`, precedence + `full` reset + persistence |
| `hugo/assets/css/ui5-overrides.css` | Extend reader cascade for `[data-embed]`; `none` removes shellbar + progress bar; relax page-kind gate |
| `hugo/layouts/partials/embed-bar.html` | **New** — slim bar for `embed=minimal` |
| `hugo/layouts/_default/baseof.html` | Conditionally render embed-bar + escape-hatch pill; conditionally load the bridge |
| `hugo/assets/js/embed-bridge.ts` | **New** — postMessage bridge (outbound + inbound, origin-validated) |
| `hugo/static/js/tutorial-pip-launcher.js` (source `hugo-apps/src/tutorial-pip-launcher/`) | Honor `pip=1` auto-launch on load |
| `hugo-apps/src/embed/*` (or colocated) | Param parser/validator + bridge unit-testable helpers |
| DB config (phased) | Admin-editable host-origin allow-list entity + read path |

## Testing

- **Unit (vitest, `hugo-apps/`):** param parser/validator (allow-list, precedence, `full` reset, `host` expansion, `step` bounds); bridge origin-validation (accept allowed origin, reject foreign origin); message serialization shape.
- **e2e (Playwright, `test/e2e/`):** `?embed=none` → no shellbar + escape pill present; `?embed=minimal` → slim bar present, no site nav; `?embed=reader` → reader cascade active; iframe harness posts `goto`/`set-embed` and asserts the tutorial reacts and emits `ready`/`step-change`. (CLAUDE.md: user-facing UI changes want a committed e2e spec.)
- **Manual demo harness:** a throwaway HTML page under `docs/` with an iframe + buttons so the POC team can exercise the bridge without BAIP.

## Out of scope / future

- Server-rendered embed variant (rejected — cache-key + parity cost).
- Composable per-chrome flags (rejected — YAGNI/combinatorial).
- Signed (not just origin-checked) host handshakes — revisit if this outlives the POC.

## Open action items for the POC team

- Confirm BAIP trial origin(s) so they're covered by the CSP `frame-ancestors` allow-list and the bridge origin allow-list. Add them if missing.
- Confirm whether BAIP will iframe or window-open first, to prioritize the manual demo harness shape (both are supported regardless).
