# Design: Kasimir Arcade — a 2.5D attract-mode game view for App-Space

- **Issue:** [sap-tutorials/tutorials-ims#3009](https://github.com/sap-tutorials/tutorials-ims/issues/3009)
- **Date:** 2026-11-03
- **Status:** Approved direction (brainstorm + spike validated); ready for planning
- **Author:** Thomas Jung (brainstormed with Claude)

## Intent & the why

App-Space is the event-floor landing page developers use at SAP events (ASUG Tech Connect, TechEd, etc.): log in → pick a track → complete tutorials → earn a prize. Today it's a static grid of track cards. At a busy booth it does nothing to pull people in from across the room.

We want a **retro-arcade entry layer** that is eye-catching through **color and motion**: when the kiosk is idle, **Kasimir the Cat** auto-runs through a Sonic-style 2.5D platform level whose zones *are* the event's tracks. The game is the hook that gets someone to walk over; the existing grid is still where the real work happens. Movement is the point — a self-playing demo loop is what catches the eye.

Crucially this is **one URL**. The kiosk loads the normal App-Space page. After a period of inactivity it auto-switches into the game ("attract mode"); any input hands control to the visitor for a few seconds of real play; reaching a track's prize chest (or a prompt) returns them to the real grid, opened on that track, for the actual login-and-launch. Walk away → attract mode resumes. A manual "▶ Play / Demo" link lets staff trigger it on demand.

## What it is

A new Vue 3 island (`hugo-apps/src/app-space-game/`) rendered as an **overlay on the existing App-Space page** — same page, same URL, no route change. It renders a **Three.js** 2.5D side-scroller: a true 3D world with lighting, shadows, parallax depth and a side-scroll camera, with **Kasimir as a "Paper-Mario" billboard** (a flat sprite standing upright in the 3D scene, lit, casting a shadow). It reads the **same data the grid already uses** and reflects the visitor's real progress when logged in.

### The level reads the track

Validated in the spike — the level is not decoration, it encodes the track structure:

- **One zone per track** (the ASUG event has 11), each with its own brand-accent color, sky, parallax pillars, and a name banner. Zones chain left→right into one continuous level.
- **One coin per tutorial**, with the **tutorial title floating above it**. Collecting coins is Kasimir passing the tutorials.
- **Checkpoint** in a track → a lit **archway gate** Kasimir runs through.
- **Prize** → a glowing **treasure chest** at the zone end, labeled with the reward. The chest is the **track selector**: reaching it is how you pick that track.
- **State is visible**: completed tutorials render as green/collected coins and the zone shows **✓ CLEARED** (logged-in only); a **locked/gated** track is dimmed, barred, and labeled with its unlock condition (e.g. "🔒 finish ABAP").

### The idle → game → handoff loop

1. Kiosk shows the normal App-Space grid at the usual URL.
2. After **N seconds** of no mouse/touch/key (default **60s**, configurable), the grid dims and the Three.js game fades in — Kasimir auto-running the attract loop, looping forever, never stuck.
3. A visitor touches/clicks/keys anything → they control Kasimir (run + jump) for a short platformer run.
4. Reaching a zone's **prize chest**, or tapping a **"Pick this track →"** prompt, fades the game out and **returns the real grid** scrolled/opened to that track.
5. Idle again → after the timeout, attract mode resumes.
6. A visible **"▶ Demo"** link in the page header triggers the game immediately.

## How it gets made (decided)

- **Platform:** New Vue 3 island in `hugo-apps/`, built into `hugo/static/js/`, mounted onto the existing App-Space page. Follows the current island pattern (`createApp(X).mount('#el')`). Reuses the app's existing dark/Horizon theming.
- **Engine:** **Three.js** (2.5D). Chosen for the boldest visual ceiling — real 3D depth, lighting, shadows. Spike proved it runs at 60fps in-browser via the standard module build.
- **Kasimir art:** **Paper-Mario billboard** using the **real existing Kasimir art** already in the repo — `hugo/static/images/devtoberfest/selfie/thumbnails/Kasimir_Smiles.png` (grey SAP-collar tuxedo cat, transparent PNG, 320×447) as the primary/run pose, with the other selfie poses (`Kasimir_Hat`, `Kasimir_Josh`, `Kasimir_Types`) and `app/display-app-drawings/public/kasimir-tuxedo.png` available for idle/jump/celebrate states. **No commissioned 3D model** — lowest art risk, still a clearly-3D scene. (The repo's `kasimir.svg` is a placeholder emoji; do not use it.)
- **Data:** Reuses the existing App-Space payload with **zero backend changes** — `GET /api/getAppSpaceProgress(eventLegacyId=N)` (CAP function returning `paths[]` → `segments`/`items` with per-item `unlocked` flags and `authenticated` state), fallback `/app-space-data.json`. The game maps: path→zone, TUTORIAL item→titled coin, CHECKPOINT→gate, PRIZE→chest, `unlocked:false`→locked zone, completed status→cleared coin/zone.
- **Reflects real progress:** When `authenticated` is true, completed tutorials render as collected/green and finished tracks as CLEARED. Logged-out: everything shows as available (purely cosmetic), game still fully playable.
- **Single URL / attract mode:** Inactivity timer on the existing page swaps grid↔game; manual trigger link; any input exits attract and gives control; handoff returns to the grid focused on the chosen track.
- **Feature-flagged & progressively rolled out**, DEV-first, consistent with how this repo ships risky UI. Flag OFF = today's grid, untouched.

## Resolved decisions (builder-check round)

A fresh builder review of this doc surfaced five gaps. The three below change what gets built and were decided by Tom; the two after are the author's (Claude's) calls.

**Decided by Tom:**

1. **Per-zone color = client-side palette.** The `getAppSpaceProgress` payload carries **no** per-track color/theme/accent field (verified against the CDS return type and the segment builders), and we hold the zero-backend-changes rule. So the game derives an 11-entry palette **client-side** from track index/title. Consequence: "the level reads the track" remains literally true for **tutorials, checkpoints, prizes, and cleared/locked state** (all data-driven); the zone *color* is attractive-but-arbitrary, not brand-matched. This is acceptable and is **not** a progress-misrepresentation anti-goal (color is decoration; the structural/state encoding is faithful). A future backend color field could upgrade this without reworking the game.

2. **Every zone always ends in a selectable goal.** Prizes are not always literal `type:'PRIZE'` items — the real payload often models a prize as a **synthetic `type:'CHECKPOINT'` item carrying `prizeId`** (per the #2887/#2889 lane-end pattern), and some tracks have no prize at all. Mapping rule: literal PRIZE → chest; prize-checkpoint (CHECKPOINT + `prizeId`) → chest; **neither → a generic "track goal" flag** that still acts as the selector. Guarantee: **no zone is ever unselectable** (directly serves the kiosk-never-stuck anti-goal).

3. **Fork / parallel-any tracks flatten to linear for v1.** A side-scroller is linear; real tracks contain `fork` (labeled lanes) and `parallel-any` (any-order) segments. v1 **flattens** every segment to one left→right line of coins (all tutorials, in segment order). Consequence: branching structure is not visually shown, but **every tutorial still appears** and the attract AI stays simple and never stalls. Faithful lane rendering is explicitly a possible v2, not v1.

**Author's calls (sensible-builder decisions):**

4. **Handoff + auth.** Reaching a zone's goal always opens the real grid on that track's detail. If the visitor is **anonymous**, the handoff lands them on the track detail and surfaces the normal sign-in affordance (the grid's existing `startLogin` path) — it does **not** dead-end on a locked prize. Attract-driven navigation must not pollute browser history (replace, don't push, when the transition is automatic).

5. **No change to `AppSpace.vue`.** The game ships as a **new sibling island** (`app-space-game`) mounted alongside the existing App-Space island on the same Hugo page. Attract-mode state, the overlay/dim, and the "▶ Demo" trigger live in the **new** island; the existing grid island is left untouched. (If a tiny hook into the grid proves unavoidable during planning, that's a plan-level call, but the intent is zero edits to `AppSpace.vue`.)

**Build fact confirmed by the review:** the `hugo-apps` Vite config already uses per-island entries that are content-hashed via the island-manifest step, so adding an `app-space-game` entry is a known low-risk pattern. **Three.js must be a dynamic import** so it loads only for this island and never bloats other pages.

## Goals

- Eye-catching color + motion that reads across a crowded event floor.
- Self-playing attract loop that never gets stuck and conveys which tracks exist.
- The level genuinely represents the track (tutorials, checkpoints, prizes, locked/cleared state), not just themed scenery.
- One URL on the kiosk; graceful, obvious handoff to the real grid for login/launch.
- Reflects the logged-in visitor's real progress.
- Zero backend changes; reuse the existing App-Space data contract.
- Fail-safe: flag OFF, or any game error, falls back to today's grid.

## Non-goals

- Not a replacement for the grid. The grid remains the canonical login/pick/launch surface; the game is an entry layer.
- No new game-progress persistence, leaderboard, or scoring stored server-side (score is ephemeral, in-session).
- No commissioned 2D sprite-sheet or 3D model in v1; reuse existing art.
- Not a full game with lives/levels/enemies — it's a short, friendly, unloseable run.
- No change to tutorial content, the publish pipeline, or the CAP services.

## Anti-goals (these mean failure even if it "works")

- **A kiosk that gets stuck** on the game and can't get back to the grid — a visitor must always reach the real flow in seconds. Any input, and a persistent exit affordance, must escape.
- **Shipping stale/broken on a kiosk GPU** — if WebGL is unavailable or the scene errors, it must silently fall back to the grid, never show a black screen or a crash.
- **Breaking the current App-Space page** for the (common) case where the game is off or unsupported.
- **Misrepresenting progress** — showing a locked track as open, or an incomplete track as CLEARED, would mislead a real attendee.
- Performance so heavy it overheats/janks an all-day booth machine.

## Constraints

- Must live behind a feature flag, default OFF, DEV-first rollout (repo convention for risky UI; see CLAUDE.md).
- Must not require any change to CAP services, the HANA content model, or the publish pipeline.
- PROD event cutover is end of July 2026; this is additive and flag-gated, so it can ship and bake on DEV without pressure on that date.
- Reuse existing Kasimir art; no external art dependency that blocks the build.
- Three.js is a new frontend dependency — must be bundled through the existing `hugo-apps` Vite build, code-split so it does not bloat non-App-Space pages.
- Kiosk browsers vary; WebGL2 preferred with graceful degradation / fallback-to-grid when absent.
- Admin-UI/approuter bundle-staleness rules do **not** apply (this is a Hugo island, not an approuter admin app), but the island-manifest/hashing build steps (`build:all`) do — the merged JS/CSS must ship hashed correctly.

## Left to the builder / plan

- Exact mapping code from `getAppSpaceProgress` payload into the zone/coin/gate/chest scene graph, applying the resolved rules above (flatten fork/parallel-any to linear; always-a-selector goal; client-side palette).
- Inactivity-timer mechanism and the grid↔game mount/unmount choreography on the shared page (overlay vs. swap, transition), kept within the new sibling island.
- The handoff target: how "reaching track X's goal" scrolls/opens the real grid to track X (reuse `syncTrackFromUrl` / selectedTrack), with replace-not-push for automatic transitions.
- Feature-flag names and gating (follow existing App-Space / KG flag conventions), plus the WebGL-support / error fallback path.
- Three.js code-splitting (dynamic import) in the Vite `hugo-apps` build; asset-loading of the Kasimir PNGs.
- Attract-AI pathing so Kasimir never stalls and the loop reads well; which poses map to run/jump/idle/celebrate.
- Accessibility & input: keyboard + touch + the manual Demo link; respect `prefers-reduced-motion`; ensure the grid remains the accessible canonical surface.
- Test strategy (unit for the data→scene mapping; the engine itself is spike-grade and largely manual/visual).
- Where the Demo trigger link lives in the header and its label/affordance.

## Prior art in-repo (reference, not reuse)

- `hugo-apps/src/devtoberfest/CatGame.vue` and `hugo-apps/src/ktt/components/KasimirStage.vue` — earlier Kasimir games/animations. **Reference only**; this is a fresh, more ambitious build per the brainstorm.
- Spike (throwaway, validated the look): `.superpowers/brainstorm/843-1793720188/content/kasimir-spike-v2b.html`. **Keeping any spike code is a new request** — the real island is built fresh through the plan.
