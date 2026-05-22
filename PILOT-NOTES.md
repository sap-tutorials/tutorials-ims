# UI Pilot — U0 + U3 + U5

Pilot scope from [improvements.md](improvements.md): adopt UI5 Web Components foundation, replace the header with `ui5-shellbar`, and add declarative `ui5-message-strip` banners on tutorial pages.

## Branch

```bash
git fetch origin
git switch ui-pilot/u0-u3-u5
npm install
```

The dependencies added are `@ui5/webcomponents`, `@ui5/webcomponents-fiori`, `@ui5/webcomponents-icons` (all `^2.22`).

## What changed

| File | Change |
| --- | --- |
| [hugo/assets/js/ui5-bootstrap.ts](hugo/assets/js/ui5-bootstrap.ts) | New entrypoint. Selectively imports ShellBar / MessageStrip / Avatar / Popover / Button / Input / List + 12 icons. Sets `sap_horizon` / `sap_horizon_dark` based on `<html data-theme>` and observes mutations to keep them in sync. |
| [hugo/layouts/_default/baseof.html](hugo/layouts/_default/baseof.html) | Adds `<script type="module" src="ui5-bootstrap.js">` (built via Hugo `js.Build`). |
| [hugo/layouts/partials/header.html](hugo/layouts/partials/header.html) | Hand-rolled `fd-shellbar` markup replaced by `ui5-shellbar` + four `ui5-popover` panels (Navigate, Share, Trust, User). All previous behavior preserved: navigate menu, share with Copy, theme toggle (icon flips between `dark-mode` / `light-mode`), help opens community.sap.com, trust links, auth flow with cached user, logout flush of `joule.*` session keys. |
| [hugo/assets/css/ui5-overrides.css](hugo/assets/css/ui5-overrides.css) | New small stylesheet (~0.8 KB gzipped). Strips legacy absolute positioning from popover containers and styles the popover internals + tutorial-banner spacing. |
| [hugo/layouts/partials/head.html](hugo/layouts/partials/head.html) | Loads `ui5-overrides.css` after `sap-fundamental.css`. |
| [hugo/layouts/partials/tutorial-banners.html](hugo/layouts/partials/tutorial-banners.html) | New partial. Renders `ui5-message-strip` for `deprecated`, `updated` (within 30 days), `notice`, `warning` frontmatter fields. |
| [hugo/layouts/tutorials/single.html](hugo/layouts/tutorials/single.html) | Calls `tutorial-banners.html` between title and meta. |
| [hugo/assets/js/tutorial.ts](hugo/assets/js/tutorial.ts) | `loadProgress` and `updateProgressBar` now inject a Positive `ui5-message-strip` saying "You completed this tutorial. Nice work!" once all steps are done. |

## How to test locally

```bash
# from worktree root
npm run dev   # hugo server --source hugo  → http://localhost:1313
```

Visit:

1. **`http://localhost:1313/tutorials/test-tutorial/`** — exercises U3 + U5 together.
   - **Shellbar** (U3): logo, title "Tutorial Platform", action buttons (Navigate, Share, Help, Theme, Legal & Trust), notification bell, profile avatar.
   - **Theme toggle**: click the dark-mode icon — UI5 components re-theme via `setTheme()` and the rest of the page swaps to dark via the existing `html.dark` class. Refresh; preference persists in `localStorage`.
   - **Navigate menu**: click → `ui5-popover` opens with Tutorials / App Space / Event Display. "My Completions" stays hidden until auth.
   - **Share popover**: click the share icon → URL appears in `ui5-input`, Copy uses `ui5-button` design="Emphasized". Copy writes to clipboard and shows status.
   - **Banners** (U5): the test-tutorial frontmatter has `updated: 2026-05-20` and `notice: "Pilot tutorial..."`. Both render as `ui5-message-strip` Information.
   - **Completed banner**: click "Done" through both steps (will fail without auth — see below).
2. **`http://localhost:1313/`** — home page renders the same shellbar but no banner partial.

To see all four banner types at once, edit the test-tutorial frontmatter:

```yaml
deprecated: { reason: "Use the new walkthrough.", supersededBy: "/tutorials/something-newer" }
updated: 2026-05-20
notice: "This is informational."
warning: "This is critical — do not run in prod."
```

## Auth-dependent paths (won't work locally without hybrid)

The shellbar profile click and progress endpoints require XSUAA. To exercise those, run the standard hybrid combo (see `CLAUDE.md` → "Local Hybrid Dev Setup"):

```bash
npm run dev:hybrid    # CAP + approuter on :5000
```

The shellbar should render identically inside the approuter.

## Performance budget

Captured on `hugo --source hugo` after build (no IDE/profiler instrumentation):

| Asset | Raw | Gzipped |
| --- | ---: | ---: |
| `public/js/ui5-bootstrap.js` (new) | 730 KB | **159 KB** |
| `public/css/ui5-overrides.css` (new) | 1.7 KB | **0.8 KB** |
| `public/css/sap-fundamental.css` (existing) | 768 KB | 86 KB |
| `public/js/tutorial.js` (existing) | 9.8 KB | 3.0 KB |
| `public/js/joule.js` (existing) | 21 KB | 5.6 KB |

**Net add per page-load: ~160 KB gzipped** (one-time, cached after first hit).

This is the perf cost Tom flagged. Tradeoffs:

- The bundle is loaded as a deferred ES module — no render-block.
- Tree-shaking is already aggressive; further cuts would mean dropping components (e.g., not using `ui5-input`/`ui5-button` inside the share popover and falling back to native).
- If the budget is too high, we can move the bootstrap from `baseof.html` (every page) to `tutorials/single.html` only — but that loses U3 cohesion on home / mission pages.

## Open questions for cohesion review

1. **Notifications bell** — the shellbar shows it via `show-notifications`, but the previous implementation had no functional notifications either. Wire it to something later, or `hide` for now?
2. **Joule trigger** — currently rendered as `<ui5-shellbar-item id="sb-joule" hidden>` and shown by other code. The original had `id="joule-trigger"` — I kept the click hook but the joule-panel.js may need a small selector update.
3. **Search** — `ui5-shellbar` has a built-in search slot; we're not using it. Want a global search added as part of cohesion?
4. **Mobile breakpoint** — `ui5-shellbar` auto-collapses items into an overflow menu under ~600 px. The hand-rolled version did not. Verify it matches the existing breakpoints.

## Rolling back

The pilot is fully contained on this branch. To abandon:

```bash
git switch main
git worktree remove .worktrees/ui-pilot-u0-u3-u5
git branch -D ui-pilot/u0-u3-u5
```

No `main` files were modified; all changes live in this worktree's branch only.
