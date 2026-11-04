# Kasimir Arcade "Game Feel" Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kasimir Arcade App-Space game feel like a real (but unloseable) platformer — animated sprite Kasimir, solid obstacles + pits with consequence, two-way movement, readable labels, a ring HUD, a richer scene, and a per-machine URL disable — all client-side, flag-gated, fail-safe to the grid.

**Architecture:** Extend the existing `hugo-apps/src/app-space-game/` island. Pure, deterministic logic (disable-gate, obstacle/pit placement, physics step, ring state, label layout, sprite frame-map, autopilot decisions) lives in small new modules unit-tested with plain vitest; `renderer.ts` stays the thin Three.js shell that calls them and is covered only by the mocked-`three` contract guard. A one-shot `scripts/` node tool keys the cream background to transparent and repacks the two gallery sheets into a uniform atlas + frame-map JSON, committed into the repo.

**Tech Stack:** Vue 3 island, Three.js `^0.161.0` (dynamic-imported), TypeScript, vitest (`npx vitest run <path>`), Node for the sprite-prep script.

**Spec:** `docs/superpowers/specs/2026-11-04-kasimir-arcade-game-feel-design.md`

## Global Constraints

- **Zero backend changes** — no CAP/CDS/HANA/publish-pipeline edits; no change to `getAppSpaceProgress` or its return type.
- **Feature flag `APP_SPACE_GAME_ENABLED` unchanged** (DB, default OFF, DEV-only). The new `nogame` disable is layered on top, never a replacement.
- **Fail-safe to the grid:** flag OFF, `nogame` set, WebGL unavailable, or any scene/physics/asset error → today's grid, untouched. No throw escapes into the page; every new entry path is wrapped.
- **No `AppSpace.vue` edits** unless unavoidable; the grid island stays untouched.
- **Three.js stays dynamically imported** (`await import('./renderer')`); the disable-gate must short-circuit *before* that import.
- **Tests are scoped only:** run `npx vitest run <path>` — never the bare suite (a repo hook blocks it).
- **TypeScript**, 2-space indent, follow existing island style. New pure modules export named functions; no default exports.
- **LF line endings** — verify with `file <path>` after multi-edit work on Windows; normalize before commit.
- Targets **DEV** via PR (feature PRs target DEV, not main).

## Review Focus

- **`localStorage` unavailable/throws** (private mode, quota, disabled cookies) — the disable-gate must treat a throw as "not disabled" and never break the page. Covered in Task 1.
- **Degenerate level data** — a zone with 0 coins, 1 coin, or a very long title; obstacle/pit placement must still yield a completable, non-empty path and labels must not divide-by-zero. Covered in Tasks 3 & 6.
- **Jump arc vs. gap width** — an obstacle/pit wider than the fixed jump arc can clear would make a zone impossible; placement must be clamped to the arc and a test must assert it for every generated gap. Covered in Task 3.
- **Autopilot wedge** — physics/AI that stalls `kasX` with no recovery; the 3s watchdog + respawn must guarantee forward progress from any state, including standing inside an obstacle. Covered in Tasks 4 & 5.
- **Atlas load failure** — frame-map JSON or atlas PNG 404/corrupt at runtime must fall back to the static `Kasimir_Smiles.png` billboard, game still runs. Covered in Task 8.

---

## Task 1: Per-machine disable gate (`nogame`)

**Files:**
- Modify: `hugo-apps/src/app-space-game/feature.ts` (add `isGameDisabled`)
- Modify: `hugo-apps/src/app-space-game/AppSpaceGame.vue` (call it first in `onMounted`, before `isWebGLAvailable()` and the dynamic import)
- Test: `hugo-apps/src/app-space-game/__tests__/disable-gate.test.ts` (new)

**Interfaces:**
- Produces: `isGameDisabled(search: string, storage: Pick<Storage,'getItem'|'setItem'> | null): boolean` — pure, injectable. `search` is `window.location.search`; `storage` is `window.localStorage` or `null`. Reads `nogame` param: `1`/`true` → sets storage key `appSpaceGameDisabled='1'` and returns `true`; `0`/`false` → removes the key and returns `false`; absent → returns `true` iff stored key is `'1'`. All storage access wrapped so a throw → treated as no stored value. Never throws.

- [ ] **Step 1: Write the failing test** — `disable-gate.test.ts` asserting: `?nogame=1` → true (and writes storage); `?nogame=0` → false (and clears storage); no param + stored `'1'` → true; no param + empty storage → false; `storage=null` → falls back to param-only and never throws; a `storage` whose `getItem`/`setItem` throw → still returns the param-derived value without throwing.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run hugo-apps/src/app-space-game/__tests__/disable-gate.test.ts` → FAIL (`isGameDisabled` not exported).
- [ ] **Step 3: Implement `isGameDisabled` in `feature.ts`** — parse `URLSearchParams(search)` case-insensitively for `nogame`; wrap all `storage` calls in try/catch.
- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Wire into `AppSpaceGame.vue`** — at the very top of `onMounted`, `if (isGameDisabled(window.location.search, safeLocalStorage())) return`, where `safeLocalStorage()` returns `window.localStorage` or `null` inside try/catch. Place before `isWebGLAvailable()`.
- [ ] **Step 6: Commit** — `feat(app-space-game): per-machine nogame disable gate (#3009)`.

---

## Task 2: Readable labels — fix overlap & cutoff

**Files:**
- Create: `hugo-apps/src/app-space-game/label-layout.ts`
- Modify: `hugo-apps/src/app-space-game/renderer.ts` (`makeLabel` uses the new sizing; coin labels use staggered height)
- Test: `hugo-apps/src/app-space-game/__tests__/label-layout.test.ts` (new)

**Interfaces:**
- Produces:
  - `fitLabel(text: string, opts?: {maxChars?: number}): { lines: string[]; canvasW: number; canvasH: number; worldW: number; worldH: number }` — measures/wraps: splits into ≤2 lines, ellipsizes past `maxChars` (default 28), sizes the canvas to the longest line at the fixed font, and returns a world width capped so a label never exceeds the 4.5-unit coin pitch + padding.
  - `coinLabelY(baseY: number, coinIndex: number): number` — staggers ±0.4 alternating on even/odd index.

- [ ] **Step 1: Write the failing test** — `label-layout.test.ts`: short text → 1 line, `worldW ≤ 4.5`; a 60-char title → 2 lines or single ellipsized line, `worldW` still ≤ cap; empty string → non-zero canvas, no throw; `coinLabelY(baseY,0)` and `(baseY,1)` differ by 0.8.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run .../label-layout.test.ts` → FAIL.
- [ ] **Step 3: Implement `label-layout.ts`** — pure string/number math only (no canvas DOM); the renderer feeds the returned sizes into the real `CanvasTexture`.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Refactor `makeLabel` in `renderer.ts`** to size its canvas from `fitLabel` (draw each line; raise canvas resolution 2×), and set coin-label Y from `coinLabelY`. Do not change the 4.5 coin pitch.
- [ ] **Step 6: Guard regression** — `npx vitest run hugo-apps/src/app-space-game/__tests__/renderer.guard.test.ts` → PASS.
- [ ] **Step 7: Commit** — `fix(app-space-game): readable, non-overlapping labels (#3009)`.

---

## Task 3: Obstacle & pit placement (deterministic, completable)

**Files:**
- Modify: `hugo-apps/src/app-space-game/types.ts` (add `Obstacle`, `Pit`, extend `Zone`)
- Create: `hugo-apps/src/app-space-game/obstacles.ts`
- Modify: `hugo-apps/src/app-space-game/level-model.ts` (populate obstacles/pits per zone)
- Test: `hugo-apps/src/app-space-game/__tests__/obstacles.test.ts` (new)

**Interfaces:**
- Produces:
  - `const JUMP_ARC = { maxGap: number; maxHeight: number }` — the horizontal distance and height the fixed `JUMP`/`GRAV` clears (computed from those constants; exported so renderer and tests share one source of truth).
  - `placeHazards(coinCount: number, zoneSeed: number): { obstacles: Obstacle[]; pits: Pit[] }` — deterministic from `(coinCount, zoneSeed)`; places light hazards *between* coin slots; every pit width ≤ `JUMP_ARC.maxGap` and every obstacle height ≤ `JUMP_ARC.maxHeight`; never two hazards closer than one jump apart (guarantees a completable path).
  - `Obstacle = { x: number; w: number; h: number }`, `Pit = { x: number; w: number }` (x in coin-index units, resolved to world X in the renderer).
- Consumes: `buildLevelModel` adds `obstacles`/`pits` to each `Zone` via `placeHazards(zone.coins.length, trackIndex)`.

- [ ] **Step 1: Write the failing test** — `obstacles.test.ts`: determinism (same args → deep-equal output); every pit width ≤ `JUMP_ARC.maxGap`; every obstacle height ≤ `JUMP_ARC.maxHeight`; no two hazards within one `JUMP_ARC.maxGap` of each other (the completable-path assertion); `coinCount` 0 and 1 → no hazards, no throw.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `obstacles.ts`** — a small seeded PRNG (mulberry32 on `zoneSeed`) for determinism; derive `JUMP_ARC` from the renderer's `JUMP=10`, `GRAV=-24`, `SPEED=6` (document the arithmetic).
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Wire into `level-model.ts`** and extend `types.ts`; keep existing `buildLevelModel` tests green (`npx vitest run .../level-model.test.ts`).
- [ ] **Step 6: Commit** — `feat(app-space-game): deterministic completable obstacle/pit placement (#3009)`.

---

## Task 4: Physics step + two-way movement (pure)

**Files:**
- Create: `hugo-apps/src/app-space-game/physics.ts`
- Test: `hugo-apps/src/app-space-game/__tests__/physics.test.ts` (new)

**Interfaces:**
- Produces:
  - `type PhysicsState = { x: number; y: number; vy: number; onGround: boolean; facing: 1 | -1; lastSafeX: number }`
  - `stepPhysics(s: PhysicsState, input: { moveDir: -1|0|1; jump: boolean }, hazards: { obstacles: Obstacle[]; pits: Pit[] }, dt: number): { next: PhysicsState; event: 'none'|'hit'|'fell' }` — applies gravity (`GRAV`), horizontal move (`SPEED*dir`), jump (`JUMP` when `onGround`), **solid-obstacle collision** (blocks horizontal crossing, allows landing on top), **pit detection** (over a pit at ground level with no jump → `fell`), updates `facing` from `moveDir`, records `lastSafeX` when on safe ground. Pure; the renderer owns `requestAnimationFrame` and reads `next`.
  - `respawn(s: PhysicsState): PhysicsState` — returns state at `lastSafeX`, grounded, `vy=0`.

- [ ] **Step 1: Write the failing test** — `physics.test.ts`: gravity pulls `y` down and lands at ground; jump from ground sets `vy>0` then arcs; running into an obstacle side does not increase `x` past it (no clip) and returns `event:'hit'` only on body contact; walking over a pit without jumping → `event:'fell'`; jumping the pit clears it; `moveDir=-1` sets `facing=-1`; `respawn` returns to `lastSafeX`.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `physics.ts`** — share `JUMP/GRAV/SPEED/JUMP_ARC` constants from a single module (re-export from `obstacles.ts` or a tiny `constants.ts`); keep collision AABB simple.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(app-space-game): pure physics step with collision, pits, two-way movement (#3009)`.

---

## Task 5: Autopilot decision + never-wedge watchdog (pure)

**Files:**
- Create: `hugo-apps/src/app-space-game/autopilot.ts`
- Test: `hugo-apps/src/app-space-game/__tests__/autopilot.test.ts` (new)

**Interfaces:**
- Produces:
  - `autopilotInput(s: PhysicsState, hazards, lookahead?: number): { moveDir: 1; jump: boolean }` — always advances right; returns `jump:true` when an obstacle/pit edge is within jump-timing range ahead. May occasionally mistime (acceptable); must never decide to stop.
  - `watchdog(progress: { lastX: number; lastAdvanceT: number; nowT: number }, s: PhysicsState): { forced: boolean; next: PhysicsState }` — if no `kasX` advance > 0.5 for > 3s, returns `forced:true` with `x` teleported past the nearest hazard and physics reset.

- [ ] **Step 1: Write the failing test** — `autopilot.test.ts`: with a pit edge just ahead → `jump:true`; clear ground ahead → `jump:false`; `moveDir` is always `1`; watchdog with `nowT-lastAdvanceT > 3` → `forced:true` and `next.x > s.x`; under 3s → `forced:false`, state unchanged. Include a state where Kasimir is lodged against an obstacle (x not advancing) → watchdog frees it.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `autopilot.ts`.**
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(app-space-game): autopilot hazard navigation + never-wedge watchdog (#3009)`.

---

## Task 6: Ring state (tally, lose-all-on-hit, reset)

**Files:**
- Create: `hugo-apps/src/app-space-game/rings.ts`
- Test: `hugo-apps/src/app-space-game/__tests__/rings.test.ts` (new)

**Interfaces:**
- Produces:
  - `type RingState = { count: number }`
  - `collect(s: RingState): RingState` — `count+1`.
  - `onHit(s: RingState): { next: RingState; scattered: number }` — `next.count=0`, `scattered` = prior count (0 when already 0 → the harmless no-op case).
  - `reset(): RingState` — `{count:0}` for each run start.

- [ ] **Step 1: Write the failing test** — `rings.test.ts`: `collect` increments; `onHit` zeroes and reports `scattered`=prior; `onHit` at 0 → `scattered:0`, stays 0; `reset` → 0.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `rings.ts`.**
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit** — `feat(app-space-game): ephemeral ring tally state (#3009)`.

---

## Task 7: Sprite-sheet prep tool (cream-key + atlas + frame-map)

> Visual task — produces committed assets, gated on a manual confirmation rather than TDD (per spec: processed cat is eyeballed before commit).

**Files:**
- Create: `scripts/build-kasimir-atlas.mjs`
- Input: `hugo/static/images/app-space-game/sprite-src/kasimir-sheet-{locomotion,actions}-raw.png` (already committed)
- Output (committed): `hugo/static/images/app-space-game/kasimir-atlas.png` + `hugo-apps/src/app-space-game/kasimir-frames.json`
- Test: `hugo-apps/src/app-space-game/__tests__/frame-map.test.ts` (new) — validates the JSON shape, not the pixels.

**Interfaces:**
- Produces `kasimir-frames.json`: `{ image: string; cell: {w,h}; clips: Record<'idle'|'walk'|'run'|'jump'|'hit'|'ko'|'celebrate'|'chest', { frames: {x,y,w,h}[]; fps: number; loop: boolean }> }`.

- [ ] **Step 1: Write `build-kasimir-atlas.mjs`** — pure Node (no new deps; use `zlib`+manual PNG or the repo's existing image lib if present — check `package.json` first). Key out near-`#F4F3EE` to alpha 0 with an edge threshold that preserves Kasimir's white chest/face; detect each pose's bounding box by alpha; repack into a uniform-cell atlas; emit the frame-map JSON mapping each pose to a clip (idle/walk/run/jump core; hit=star-dazed, ko=ghost, celebrate=arms-up, chest=chest-open).
- [ ] **Step 2: Run it** — `node scripts/build-kasimir-atlas.mjs`; write the atlas + JSON.
- [ ] **Step 3: MANUAL CONFIRMATION** — open the generated `kasimir-atlas.png`, verify the cream is gone and no part of Kasimir (white chest, eyes, SAP collar) was eaten; verify each clip's frames look right. **Show Tom before committing.** If wrong, tune the key threshold and repeat.
- [ ] **Step 4: Write `frame-map.test.ts`** — assert the JSON parses, every clip key exists, each clip has ≥1 frame, `fps>0`, frame boxes within the atlas dimensions.
- [ ] **Step 5: Run to verify it passes** — `npx vitest run .../frame-map.test.ts` → PASS.
- [ ] **Step 6: Commit** — `feat(app-space-game): Kasimir sprite atlas + frame-map from new art (#3009)`.

---

## Task 8: Sprite animation state machine (pure selection) + renderer wiring

**Files:**
- Create: `hugo-apps/src/app-space-game/anim.ts`
- Modify: `hugo-apps/src/app-space-game/renderer.ts` (animated billboard via atlas UVs; fallback to `Kasimir_Smiles.png`)
- Test: `hugo-apps/src/app-space-game/__tests__/anim.test.ts` (new)

**Interfaces:**
- Consumes: `kasimir-frames.json` (Task 7), `PhysicsState` + `event` (Task 4), `RingState` events (Task 6).
- Produces:
  - `selectClip(ctx: { onGround: boolean; moveDir: -1|0|1; vy: number; lastEvent: 'none'|'hit'|'fell'|'goal'|'pickup'; sinceEventMs: number }): ClipName` — maps state→clip: airborne→`jump`; `hit` for ~600ms after a hit; `ko` for ~800ms after a fall; `celebrate` briefly after pickup/goal; moving fast→`run`, moving→`walk`, else→`idle`.
  - `frameAt(clip: ClipName, elapsedMs: number, frames, fps, loop): number` — frame index.

- [ ] **Step 1: Write the failing test** — `anim.test.ts`: airborne → `jump`; `lastEvent:'fell'`, `sinceEventMs:200` → `ko`; `sinceEventMs:2000` → back to locomotion; `moveDir:-1` still picks walk/run (facing handled in physics); `frameAt` wraps when `loop`, clamps to last frame when not.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `anim.ts`.**
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Wire `renderer.ts`** — load the atlas texture; set the billboard material's UV offset/repeat per `frameAt`; flip UV by `facing`; **on atlas/JSON load error, fall back** to the existing single `Kasimir_Smiles.png` plane (keep today's code path as the catch). Reduced-motion: animate on manual play (do not freeze).
- [ ] **Step 6: Guard regression** — `npx vitest run .../renderer.guard.test.ts` → PASS.
- [ ] **Step 7: Commit** — `feat(app-space-game): animated sprite state machine + atlas rendering with static fallback (#3009)`.

---

## Task 9: Integrate physics/autopilot/rings/anim into the game loop + HUD + input + sound

**Files:**
- Modify: `hugo-apps/src/app-space-game/renderer.ts` (replace the ad-hoc `tick` movement with `stepPhysics`/`autopilotInput`/`watchdog`; render obstacles/pits; ring collect→`collect`, hit/fall→`onHit`+respawn; expose `ringCount` + events via a callback)
- Modify: `hugo-apps/src/app-space-game/AppSpaceGame.vue` (ring-count HUD `<div>`, scatter CSS + "−N" toast, mute toggle, updated player-hint text)
- Create: `hugo-apps/src/app-space-game/sound.ts` (WebAudio pickup blip, muted default, first-gesture gated, fails silent)
- Test: `hugo-apps/src/app-space-game/__tests__/sound.test.ts`, extend `AppSpaceGame.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8.
- Produces: `GameHandle` gains `onRingCount(cb: (n: number) => void)` and `onEvent(cb: (e:'hit'|'pickup'|'goal') => void)`; `createSound(): { enabled: boolean; toggle(): void; blip(): void }` (never throws; no-op until first gesture / when disabled).

- [ ] **Step 1: Write the failing tests** — `sound.test.ts`: `createSound().blip()` never throws with no `AudioContext`; `toggle()` flips `enabled`; starts disabled. Extend `AppSpaceGame.test.ts`: when the game reports a ring count, the HUD `<div>` shows it; mute toggle present.
- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement `sound.ts`** (guard `window.AudioContext`), the HUD + toggle in the Vue component (reactive `ringCount`, CSS shake/flash, `−N` toast ~800ms), and the renderer integration (drive `tick` from the pure modules; render `Obstacle`/`Pit` meshes; call `onPickTrack` on `goal` as today).
- [ ] **Step 4: Run to verify they pass** → PASS; also `npx vitest run .../renderer.guard.test.ts` and `.../feature.test.ts` → PASS.
- [ ] **Step 5: Update player-hint text** to "Tap = jump · Hold left/right = move · Reach the flag to pick a track".
- [ ] **Step 6: Commit** — `feat(app-space-game): wire physics/rings/anim into loop with HUD, input, sound (#3009)`.

---

## Task 10: Scene polish — spike then build

> The first sub-task is a throwaway spike Tom reviews; the chosen direction is then built for real.

**Files:**
- Spike (throwaway, not committed to src): a standalone HTML under `.superpowers/brainstorm/` or `$CLAUDE_JOB_DIR/tmp`.
- Modify (after pick): `hugo-apps/src/app-space-game/renderer.ts` (`buildScene` — parallax layers, set dressing, improved flag/chest geometry, per-zone color propagation)

- [ ] **Step 1: Build a throwaway spike** with 2–3 scene-direction variations (parallax depth, flag/chest styling, per-zone color treatment) against a sample level.
- [ ] **Step 2: Show Tom in a browser; he picks a direction.** Record the choice.
- [ ] **Step 3: Measure the pick's FPS on integrated-graphics-class hardware; confirm ~60fps.** Far layers cast no shadows; shadow-map resolution unchanged.
- [ ] **Step 4: Build the chosen direction into `buildScene`.**
- [ ] **Step 5: Guard regression** — `npx vitest run .../renderer.guard.test.ts` → PASS.
- [ ] **Step 6: Commit** — `feat(app-space-game): richer parallax scene + goal styling (#3009)`.

---

## Task 11: Build verification & PR

- [ ] **Step 1: Island build** — `npm run build:apps` (or scoped `npm --prefix hugo-apps run build`); confirm the `app-space-game` entry builds and Three.js stays code-split (not in shared chunks).
- [ ] **Step 2: Run all app-space-game unit tests scoped** — `npx vitest run hugo-apps/src/app-space-game/` → all PASS.
- [ ] **Step 3: Verify LF endings** on every new/modified file (`file <path>`); normalize if any flipped to CRLF.
- [ ] **Step 4: Manual smoke** — with the flag on locally and `?eventId=` set: attract auto-runs and clears hazards (occasional fail + recovery, never wedged); input gives two-way control + jump; rings count + HUD + sound; `?nogame=1` disables and persists; reduced-motion suppresses attract but manual play animates.
- [ ] **Step 5: Open PR to DEV** — `gh pr create --base DEV`, link issue #3009, summarize the seven asks and the zero-backend/flag-gated/fail-safe guarantees.
