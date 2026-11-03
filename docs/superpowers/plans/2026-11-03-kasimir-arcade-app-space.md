# Kasimir Arcade — App-Space Attract-Mode Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-flagged Three.js 2.5D attract-mode game ("Kasimir Arcade") as an entry layer over the existing App-Space page — same URL — that reads the event's real track data, auto-plays when idle, and hands off to the real grid when a visitor picks a track.

**Architecture:** A new, self-contained Vue 3 island (`app-space-game`) mounts as a sibling to the existing App-Space island on the same Hugo page. A pure data-mapping module turns the existing `getAppSpaceProgress` payload into a renderer-agnostic "level model" (zones/coins/gates/goals). A Three.js renderer (dynamically imported so it never loads on other pages) draws the level and runs the attract/play loop. The existing `AppSpace.vue` grid island is **not** modified. Everything is gated by a runtime DB flag and falls back to the untouched grid when the flag is OFF, WebGL is unavailable, or the game errors.

**Tech Stack:** Vue 3 + TypeScript, Three.js (new dep, dynamic import), Vite (`hugo-apps` island build), Hugo layout mount, CAP `ImsConfig`-backed feature flag, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-kasimir-arcade-app-space-design.md`

## Global Constraints

- **Zero backend changes to data:** reuse `GET /api/getAppSpaceProgress(eventLegacyId=N)` as-is; fallback `/app-space-data.json`. No change to CAP services, HANA model, or publish pipeline. (The feature *flag* reuses the existing generic `ImsConfig` flag mechanism — no new persistence.)
- **Do not modify `hugo-apps/src/app-space/AppSpace.vue`** or its `main.ts`. The game ships as a new sibling island.
- **Three.js must be a dynamic `import()`** inside the island, so it is code-split and only fetched for this island — never bloats other pages.
- **Feature flag default OFF, DEV-first.** Flag OFF ⇒ game never mounts/renders; the page is exactly today's grid.
- **Fail-safe:** no WebGL, or any game error ⇒ silently fall back to the grid; never a black screen or crash; never break the existing page.
- **Native HTTP only:** use built-in `fetch` (Node 20+/browser); no axios/node-fetch.
- **Kasimir art is existing repo assets** (served from `hugo/static/...`): primary `images/devtoberfest/selfie/thumbnails/Kasimir_Smiles.png`. Do **not** use `kasimir.svg` (placeholder emoji).
- **Item "done" rule:** an item is completed iff `item.status === 'COMPLETED'` (mirrors the grid).
- **Fork/parallel-any segments flatten to linear** for v1 (all tutorials in segment order).
- **Every zone always ends in a selectable goal** (literal PRIZE → chest; CHECKPOINT with `prizeId` → chest; neither → generic "track goal" that still selects). No zone is ever unselectable.
- **Per-zone color is derived client-side** from zone index (payload has no color field). Color is decoration; structural/state encoding is the faithful part.
- **Automatic navigation uses `history.replaceState` semantics** (replace, not push) so attract-mode transitions don't pollute browser history.

## Review Focus

- **Empty / single-zone / 11-zone events** — level model must build a valid, playable, looping level for 0 paths (render nothing, stay on grid), 1 path, and the full 11. Covered in Task 2 tests.
- **A path whose only "prize" is a synthetic CHECKPOINT-with-`prizeId`, or no prize at all** — must still yield exactly one goal object per zone. Covered in Task 2 tests.
- **Anonymous vs authenticated payload** (`authenticated` flag absent on old payloads) — logged-out must render all coins as available (never crash on missing status), logged-in reflects `COMPLETED`. Covered in Task 2 tests.
- **WebGL unavailable / `getContext` returns null on a kiosk GPU** — must resolve to "unsupported" and leave the grid visible, not throw. Covered in Task 4 tests.
- **Flag OFF or probe fails (503/network)** — island must not render the game and must leave the grid intact. Covered in Task 3 tests.

---

## File Structure

- `hugo-apps/src/app-space-game/main.ts` — island entry; reads mount el, probes flag + WebGL, decides mount-or-bail.
- `hugo-apps/src/app-space-game/AppSpaceGame.vue` — Vue shell: owns attract/idle state machine, overlay/dim, "▶ Demo" trigger, handoff navigation. Dynamically imports the renderer.
- `hugo-apps/src/app-space-game/level-model.ts` — pure functions: payload → `LevelModel` (zones/coins/gates/goals). No Three.js, no DOM. The testable core.
- `hugo-apps/src/app-space-game/feature.ts` — flag probe + WebGL-support check (best-effort, never throws).
- `hugo-apps/src/app-space-game/renderer.ts` — Three.js scene builder + attract/play loop over a `LevelModel`. Imported dynamically.
- `hugo-apps/src/app-space-game/types.ts` — shared types (`LevelModel`, `Zone`, `Coin`, `Goal`, payload shapes reused from app-space).
- `hugo-apps/src/app-space-game/__tests__/level-model.test.ts`, `feature.test.ts`, `AppSpaceGame.test.ts`.
- Modify: `hugo-apps/vite.config.ts` — add `'app-space-game'` island entry.
- Modify: `hugo/layouts/app-space/list.html` — add sibling mount div + island script tag.

---

## Task 1: Island scaffold + build wiring (mounts, does nothing visible)

**Files:**
- Create: `hugo-apps/src/app-space-game/main.ts`, `hugo-apps/src/app-space-game/AppSpaceGame.vue`, `hugo-apps/src/app-space-game/types.ts`
- Modify: `hugo-apps/vite.config.ts:302` (add entry near `arcade`), `hugo/layouts/app-space/list.html`
- Test: `hugo-apps/src/app-space-game/__tests__/mount.test.ts`

**Interfaces:**
- Produces: island entry `app-space-game`; `AppSpaceGame.vue` default export (Vue component) mounting on `#app-space-game`; `types.ts` exporting `AppSpaceItem`, `AppSpaceTrack`, `AppSpaceData` (re-declared to match `hugo-apps/src/app-space/AppSpace.vue` interfaces, lines 53–118) plus `LevelModel`/`Zone`/`Coin`/`Goal` (defined in Task 2).

- [ ] **Step 1: Write the failing test** — `mount.test.ts`: mounting `AppSpaceGame` with no flag/WebGL stubs renders nothing game-related (no `<canvas>`, grid untouched); asserts component mounts without throwing and exposes a `data-app-space-game` root.
- [ ] **Step 2: Run test, verify it fails** — `cd hugo-apps && npx vitest run src/app-space-game/__tests__/mount.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the three files minimally: `types.ts` with the payload interfaces copied to match app-space; `AppSpaceGame.vue` rendering only a hidden root `<div data-app-space-game>`; `main.ts` = `const el=document.getElementById('app-space-game'); if (el) createApp(AppSpaceGame).mount(el)`. Add the Vite entry `'app-space-game': resolve(__dirname, 'src/app-space-game/main.ts')`. Add to the Hugo layout: `<div id="app-space-game"></div>` + `<script type="module" src="{{ partial "island-src.html" "app-space-game" }}"></script>`.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `feat(app-space-game): island scaffold + build wiring (#3009)`.

---

## Task 2: Level model — payload → LevelModel (the testable core)

**Files:**
- Create: `hugo-apps/src/app-space-game/level-model.ts`
- Modify: `hugo-apps/src/app-space-game/types.ts` (add model types)
- Test: `hugo-apps/src/app-space-game/__tests__/level-model.test.ts`

**Interfaces:**
- Consumes: `AppSpaceData`/`AppSpaceTrack`/`AppSpaceItem` from `types.ts`.
- Produces: `buildLevelModel(data: AppSpaceData): LevelModel` where
  `LevelModel = { zones: Zone[] }`;
  `Zone = { id: string; title: string; colorIndex: number; cleared: boolean; locked: boolean; coins: Coin[]; gates: Gate[]; goal: Goal }`;
  `Coin = { title: string; done: boolean; available: boolean }`;
  `Gate = { afterCoinIndex: number }`;
  `Goal = { kind: 'prize' | 'checkpoint' | 'track'; label: string; prizeId: number | null; trackId: string }`.
  Also `zoneColor(colorIndex: number): string` returning a hex from an 11-entry palette (index mod palette length).

- [ ] **Step 1: Write the failing tests** — `level-model.test.ts`, each with spec values:
  - empty `paths` ⇒ `zones.length === 0`.
  - one linear path, 3 TUTORIAL items ⇒ 1 zone, 3 coins in order, titles preserved.
  - fork + parallel-any segments ⇒ coins flattened to one ordered list (count = total tutorials across lanes/clusters).
  - path with a literal `type:'PRIZE'` item ⇒ `goal.kind==='prize'`.
  - path whose only prize is `type:'CHECKPOINT'` + `prizeId` ⇒ `goal.kind==='checkpoint'`, `prizeId` preserved.
  - path with neither ⇒ `goal.kind==='track'`, `goal.trackId` set.
  - `authenticated` + some `status:'COMPLETED'` ⇒ those coins `done:true`; zone with all tutorials COMPLETED ⇒ `cleared:true`.
  - anonymous payload (no `authenticated`, items lack `status`) ⇒ all coins `available:true, done:false`; no throw.
  - `unlocked:false` items ⇒ zone `locked:true`, coins `available:false`.
  - CHECKPOINT item mid-list ⇒ a `Gate` with correct `afterCoinIndex`.
  - `zoneColor(0..11)` returns distinct hex strings, wraps at palette length.
- [ ] **Step 2: Run tests, verify they fail** — `npx vitest run src/app-space-game/__tests__/level-model.test.ts` — Expected: FAIL (`buildLevelModel` not defined).
- [ ] **Step 3: Implement `buildLevelModel` and `zoneColor`** in `level-model.ts`. Flatten `segments` (linear/parallel-any/fork lanes) in order to a coin list; TUTORIAL→coin, CHECKPOINT→gate unless it carries `prizeId` (then it's the goal); choose goal by the resolved-decision rule; derive `locked`/`cleared`/`done` from `unlocked` and `status==='COMPLETED'`. Pure functions, no DOM/Three.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(app-space-game): level model from app-space payload (#3009)`.

---

## Task 3: Feature gate — flag probe + data load + mount decision

**Files:**
- Create: `hugo-apps/src/app-space-game/feature.ts`
- Modify: `hugo-apps/src/app-space-game/main.ts` (wire the gate), `AppSpaceGame.vue` (fetch + build model on mount)
- Test: `hugo-apps/src/app-space-game/__tests__/feature.test.ts`

**Interfaces:**
- Produces:
  `isGameEnabled(): Promise<boolean>` — best-effort flag probe (reuses the generic `ImsConfig` flag path; returns false on 503/network/absent, never throws).
  `isWebGLAvailable(): boolean` — creates a throwaway canvas, returns `!!getContext('webgl2'|'webgl')`, false on any error.
  `loadAppSpaceData(): Promise<AppSpaceData | null>` — `fetch('/api/getAppSpaceProgress(...)')` with the same eventId resolution the grid uses; fallback `/app-space-data.json`; null on failure.

- [ ] **Step 1: Write the failing tests** — `feature.test.ts`: `isGameEnabled` resolves false on a mocked 503 and on network reject; true on ok. `isWebGLAvailable` returns false when `getContext` is stubbed to null. `loadAppSpaceData` returns parsed data on ok, falls back to the json file on primary failure, null when both fail. (Mock `fetch`/`getContext`.)
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement `feature.ts`** per signatures (model the flag probe on `hugo-apps/src/ktt/lib/server.ts` `isKttEnabled`). Wire `main.ts`: mount the component always, but the component only proceeds to render the game when `isGameEnabled() && isWebGLAvailable() && data` — otherwise it stays hidden (grid intact).
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(app-space-game): feature gate (flag + webgl + data load) (#3009)`.

---

## Task 4: Three.js renderer + attract/play loop (dynamic import)

**Files:**
- Create: `hugo-apps/src/app-space-game/renderer.ts`
- Modify: `AppSpaceGame.vue` (dynamic-import the renderer when gate passes), `hugo-apps/package.json` (add `three`)
- Test: `hugo-apps/src/app-space-game/__tests__/renderer.guard.test.ts`

**Interfaces:**
- Consumes: `LevelModel` (Task 2).
- Produces: `createGame(canvas: HTMLCanvasElement, model: LevelModel, opts: { onPickTrack: (trackId: string) => void }): { start(): void; stop(): void; setPlayerControl(on: boolean): void }`. The renderer builds zones (colored via `zoneColor`), titled coins, gates, goal chests/flags, the Kasimir billboard (texture from the existing PNG path), runs the auto-run attract loop, and calls `onPickTrack` when Kasimir reaches a zone goal under player control.

- [ ] **Step 1: Write the failing test** — `renderer.guard.test.ts` (pure logic only; no real WebGL in Vitest): import `renderer.ts`, assert `createGame` is a function and that calling `stop()` before `start()` does not throw. (Three.js is heavy; keep engine testing manual/visual per spec. This test only guards the module contract.)
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `renderer.ts`** — port the validated spike (`.superpowers/brainstorm/843-1793720188/content/kasimir-spike-v2b.html`) into a typed module over a `LevelModel`: lighting, shadows, parallax, per-zone color, titled coins, checkpoint gates, goal object, Kasimir billboard + shadow, camera follow, attract auto-run that loops, `setPlayerControl` to hand over, goal-reached ⇒ `onPickTrack`. Add `three` to `hugo-apps/package.json` deps. In `AppSpaceGame.vue`, `await import('./renderer')` only after the gate passes.
- [ ] **Step 4: Run test, verify it passes**, and run `npx vitest run src/app-space-game` (all island tests green).
- [ ] **Step 5: Commit** — `feat(app-space-game): three.js renderer + attract loop (#3009)`.

---

## Task 5: Attract state machine, overlay/dim, Demo trigger, handoff

**Files:**
- Modify: `hugo-apps/src/app-space-game/AppSpaceGame.vue`
- Test: `hugo-apps/src/app-space-game/__tests__/AppSpaceGame.test.ts`

**Interfaces:**
- Consumes: `createGame` (Task 4), `isGameEnabled/isWebGLAvailable/loadAppSpaceData` (Task 3), `buildLevelModel` (Task 2).
- Produces: the finished island behavior (no new exported API).

- [ ] **Step 1: Write the failing tests** — `AppSpaceGame.test.ts` (mock `createGame`): (a) with gate stubbed to pass, after the idle timeout (fake timers, default 60000ms) the overlay becomes visible and `game.start()` is called; (b) a simulated input event while attract is showing calls `setPlayerControl(true)` and keeps the overlay; (c) the "▶ Demo" trigger is present and clicking it starts the game immediately; (d) `onPickTrack(id)` navigates to the track via `history.replaceState` (assert `location`/`replaceState` spy, not `pushState`) and hides the overlay; (e) with gate stubbed to fail, no overlay, no timer, `createGame` never called.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** the idle-timer state machine (reset on mouse/touch/key; respect `prefers-reduced-motion` by not auto-starting), the dim/overlay, the Demo trigger button, and the handoff: `onPickTrack` sets the track in the URL (`?...&track=<id>` style the grid already understands via `syncTrackFromUrl`) using `replaceState` for auto-nav, then hides the overlay so the untouched grid shows selected. Mount into the sibling div from Task 1.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(app-space-game): attract loop, demo trigger, track handoff (#3009)`.

---

## Task 6: Build verification + docs

**Files:**
- Modify: `docs/developers/architecture/frontend-apps.md` (one-line island entry), CLAUDE.md subsystem one-liner if warranted.
- Test: production island build.

- [ ] **Step 1:** Run `npm run build:all` (via `scripts/quiet-run.sh`) and verify the `app-space-game` entry appears content-hashed in `hugo/static/js/.vite/manifest.json` and that `three` is code-split into its own chunk (not in other islands' bundles).
- [ ] **Step 2:** Grep the built output to confirm no other island entry gained a `three` import.
- [ ] **Step 3:** Add the one-line island doc entry.
- [ ] **Step 4: Commit** — `docs,build(app-space-game): verify code-split build + document island (#3009)`.

---

## Self-review notes

- **Spec coverage:** attract/idle→game→handoff (T5), one-URL + Demo trigger (T5), zone-per-track + coins/gates/goal + cleared/locked (T2+T4), reflects-progress (T2), client palette (T2), flatten forks (T2), always-a-selector (T2), zero-backend + reuse payload (T3, Global Constraints), new sibling island / no AppSpace.vue edit (T1, Global Constraints), Three.js dynamic import/code-split (T4+T6), WebGL + flag fallback (T3), fail-safe (T3/T5). All mapped.
- **Type consistency:** `LevelModel`/`Zone`/`Coin`/`Gate`/`Goal` defined once in `types.ts`/Task 2 and consumed unchanged by Tasks 4–5; `createGame`'s `onPickTrack(trackId)` matches the handoff in Task 5; `status==='COMPLETED'` and `unlocked:false` match the grid's own rules.
- **Proportion:** plan is close to the spec's length; code blocks are test names/assertions and signatures, not bodies (the renderer body is the ported spike, left to the implementer).
