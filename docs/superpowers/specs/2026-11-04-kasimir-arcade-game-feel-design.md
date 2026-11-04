# Design: Kasimir Arcade — "make it feel like a game" enhancement round

- **Issue:** [sap-tutorials/tutorials-ims#3009](https://github.com/sap-tutorials/tutorials-ims/issues/3009) (enhancement comments)
- **Date:** 2026-11-04
- **Status:** Brainstormed with Tom; builder-check pending; targets **DEV** (feature PRs target DEV, flag already DEV-only)
- **Author:** Thomas Jung (brainstormed with Claude)
- **Builds on:** [2026-11-03-kasimir-arcade-app-space-design.md](2026-11-03-kasimir-arcade-app-space-design.md) — the original Kasimir Arcade design. That design, its goals/non-goals/anti-goals, and its zero-backend-changes rule all still hold. This doc is an **additive enhancement round**, not a rewrite.

## Intent & the why

The Kasimir Arcade island shipped to DEV (`hugo-apps/src/app-space-game/`, flag `APP_SPACE_GAME_ENABLED`, default OFF). On the kiosk it does its job of catching the eye with color and motion — but as a *game* it reads as fake. Tom's words: "it just feels unreal," and he wants it to "simulate being somewhat a game" with "some challenge," while staying "not difficult."

Today Kasimir auto-runs rightward only, clips straight through every obstacle, can't fall, can't lose, can't turn around, and the floating text is cut off and overlapping to the point of being unreadable (see issue screenshots). There is no feedback when a ring is collected and no score. The result is motion without substance.

This round makes the arcade **feel like a real little game**: obstacles that actually stop you and must be jumped, pits you fall into, a ring count that scatters when you get hit, readable labels, and two-way movement — while staying a short, forgiving, **unloseable** booth attractor whose whole purpose is still to hand the visitor off to the real grid. The word Tom used is **"simulate"**: it should *feel* like a game, not *become* a scored game. Nothing here escapes the overlay or touches the backend.

## What changes (the six asks)

Mapped to the issue comment, in the order Tom raised them:

### 1. Per-machine disable via URL parameter

A booth laptop must be able to opt out of the game **without a redeploy** and have it stick for that machine.

- A query parameter disables the island entirely **before any Three.js loads**, independent of the server `APP_SPACE_GAME_ENABLED` flag. Param name: **`nogame`** (`?nogame=1` disables; `?nogame=0` re-enables).
- The choice is **remembered per machine** in `localStorage` (key `appSpaceGameDisabled`), so staff set it once on that kiosk and it persists across reloads and navigations without keeping the param in the URL.
- Precedence: an explicit `?nogame=0` clears the stored opt-out; `?nogame=1` sets it; with no param, the stored value (if any) decides; absent both, the server flag decides as today.
- When disabled this way, the page behaves exactly like flag-OFF: today's grid, untouched, no game code paths armed.

### 2. Readable labels

The issue screenshot shows text cut off, overlapping, and unreadable. Root cause (confirmed in `renderer.ts` `makeLabel`): every label is drawn into a **fixed 512×96 canvas** with a fixed 40px font and no wrapping, then scaled to a fixed world width (coins are 4.5 world-units apart but coin labels are scaled ~6 units wide, so adjacent labels physically overlap; long titles overflow the 512px canvas and clip).

Fix — a rebuilt label system:

- **Size the texture to the text** (measure the string, size the canvas to fit) and raise device-pixel resolution so text is crisp, not blurry-then-clipped.
- **Wrap or ellipsize** long tutorial titles to a max width / line count instead of letting them run off the canvas edge.
- **Space labels so neighbors don't collide** — stagger label height per coin and/or widen coin spacing so a label's world footprint never overlaps the next coin's label.
- Keep the readable-outline treatment (dark stroke under light fill) that already exists; it works, it's the sizing that's broken.

### 3. Richer, less-boring scene

"The background, flags and obstacles are too simplistic and boring." Today each zone is a flat ground slab + 3 box pillars + a single flat sky plane; flags are a 2×1.2 plane on a thin pole; chests are two boxes.

Make it read as a real level across a crowded room, still zero-backend and still mapping the same data. Because this is taste-driven, the direction is chosen via a **throwaway visual spike** (2–3 variations shown to Tom in a browser) before the real build — see Resolved Decision 3. Candidate improvements the spike explores:

- **Layered parallax backdrops** (multiple depth planes moving at different rates) instead of one flat wall, so motion reads with depth from across the floor.
- **More varied, lightly-animated set dressing** per zone (the parallax pillars gain variety/motion; add simple mid-ground and far-ground elements).
- **Better goal objects** — flags and treasure chests that look less primitive (more geometry, glow, a little motion), since the chest is the track-selector and should look worth reaching.
- **Per-zone color carries** more strongly across sky/ground/dressing so the 11 tracks read as distinct zones.
- This is taste-driven polish; the structural data mapping (zone/coin/gate/goal) is unchanged. Perf bar: ~60fps on integrated-graphics booth hardware (Resolved Decision 5).

### 4. Two-way movement

"Kasimir only moves forward, he should be able to navigate backwards too."

- Add **Left** movement: `ArrowLeft` / `a`, and the left half of a touch/pointer input, move Kasimir left; Right unchanged.
- Current touch scheme (tap = jump, hold-right-half = run right) is reworked so left-half = run left, right-half = run right, and a distinct gesture (tap / swipe-up) = jump — documented in the player hint.
- Kasimir's billboard **faces the direction of travel** (flip the sprite) so backward movement reads correctly.
- Camera and world bounds follow both directions; you can't walk off the left edge of the level.

### 5. Real obstacles + pits (the core of "feels like a game")

"Obstacles are meaningless as you just clip through them. They should stop your avatar and make you jump over them. Kasimir should fall into pits if not jumped over. Make it truly interactive."

This is the substantive new system — collision + gravity + consequence:

- **Solid obstacles**: an obstacle has a collision box. Running into it **stops** horizontal movement (you don't clip through); you must **jump over** it. Landing on top is fine; hitting the side blocks you.
- **Pits**: gaps in the ground. If Kasimir runs over a pit without jumping, he **falls in**.
- **Consequence on a hit/fall** (Sonic-style, forgiving):
  - The ring count is a **running tally** of rings collected this run. A hit **scatters and loses all of them** (count drops toward 0). A hit while holding **0 rings is a harmless no-op** (just the respawn).
  - Kasimir does a quick tumble / "oof", then **respawns at the last safe ground** a beat later (~1s). The run **continues** — there is **no game-over**, no lives, no end screen.
- **Where obstacles/pits come from**: they are **procedurally placed decoration** derived deterministically from the level layout (e.g. between some coins), **not** from the App-Space payload — there is no obstacle data in the contract and we hold zero-backend-changes. Placement is tuned to be light ("not difficult") and must always leave a **completable path** (jump timing that a human and the autopilot can both clear).
- **Autopilot navigates them too** (Tom's hard rule): attract-mode Kasimir **attempts** the jumps on a timed/heuristic basis, **may occasionally fail** (that's fine and adds life), and on failure **self-recovers** via the same respawn so the loop **never wedges**. The never-stuck anti-goal is paramount: if any recovery path could stall, the autopilot must favor skipping/clearing over risking a wedge.

### 6. Ring pickup feedback + HUD score

"Some visual indicator that you picked up a ring. A score of rings picked up as well."

- **Pickup feedback**: collecting a ring triggers a visible pop / sparkle / flash at the ring and a short **pickup sound** (muted by default, unmute toggle, gated on first user gesture; fails silently where audio is blocked/unsupported), so it's obvious you got it — today the ring just silently vanishes.
- **HUD ring counter**: a live count of rings collected this run, drawn as a DOM `<div>` HUD overlay (reactive, top corner), compositing above the Three.js canvas.
- **Strictly ephemeral**: the count **resets every run**, **drops to 0 on a hit** (scatter), and is **never persisted and never carried over to the real App-Space page**. No backend, no gameboard, no per-user storage. The mute toggle is per-session UI state, not persisted. (Upholds the original design's "no scoring stored server-side" non-goal; Tom restated this explicitly.)

## How it gets made (decided)

- **Same island, same stack.** All changes live in `hugo-apps/src/app-space-game/` — `renderer.ts` (scene, physics, HUD, input), `AppSpaceGame.vue` (gate, overlay, disable param), `feature.ts` (disable-param gate), `level-model.ts`/`types.ts` (obstacle/pit layout model). Three.js stays the engine, still dynamic-imported and code-split. No new island, no route change, one URL.
- **No `AppSpace.vue` edits** unless a tiny hook proves unavoidable at plan time (same stance as the original design). The grid island stays untouched.
- **Zero backend changes.** No change to `getAppSpaceProgress`, the CDS return type, CAP services, the HANA model, or the publish pipeline. Obstacles/pits/score are all client-side.
- **Feature flag unchanged.** `APP_SPACE_GAME_ENABLED` (DB, default OFF, DEV-only) still gates the whole island. The new `?nogame`/`localStorage` disable is an **additional** client-side off-switch layered on top, not a replacement.
- **Fail-safe preserved.** Flag OFF, `nogame` set, WebGL unavailable, or any scene/physics error → today's grid, untouched. No black screen, no crash.
- **Tests.** Extend the existing vitest suites (`__tests__/`): pure/deterministic logic gets real unit tests — the disable-param precedence, label sizing/wrapping math, obstacle/pit placement (always-completable, deterministic), ring-count arithmetic (collect/scatter/reset), respawn-to-last-safe-ground selection, and direction/facing. The Three.js rendering itself stays spike-grade and largely manual/visual, consistent with the original design's test strategy.

## Resolved decisions (builder-check round)

A fresh builder reviewed this doc. The five below were **Tom's to decide** and change what gets built; the six after are the author's (Claude's) calls.

**Decided by Tom:**

1. **"Completable" = geometric gap rule.** The completability test asserts that for every obstacle/pit, there exists a jumpable gap given the **fixed jump arc** (jump height/length derived from `JUMP`/`GRAV`) — i.e. no placement requires a jump the fixed arc cannot make, and no obstacle/pit spans more than the arc can clear. Pure deterministic math over the placement layout; **no physics simulation** in the test. This is the oracle precisely *because* the autopilot is allowed to occasionally fail, so "autopilot clears it" cannot be the assertion.

2. **Ring count = running tally, lose all on hit (Sonic-classic).** The HUD count is the number of rings collected so far **this run**. A hit (obstacle collision consequence / pit fall) **scatters and loses all of them**, dropping the count toward 0. A hit while holding **0 rings is a harmless no-op** (visually just the respawn, no scatter). Still fully ephemeral: resets each run, never persisted, never leaves the overlay.

3. **Scene polish (ask 3) = spike first, Tom picks.** Because "less simplistic and boring" is taste, the builder first produces a **throwaway visual spike** with 2–3 scene-direction variations (parallax depth, flag/chest styling, per-zone color treatment), shown to Tom in a browser; Tom picks the direction; the chosen direction is then built for real. The spike is throwaway (no tests, not shipped); keeping any spike code is a new request. This de-risks open-ended polish and gives ask 3 a concrete acceptance target once the direction is chosen.

4. **Ring-pickup sound = in scope.** A short WebAudio pickup blip, **muted by default** with an unmute toggle, and gated on the **first user gesture** (respects browser autoplay policy). The game has no audio today, so this adds a minimal `AudioContext` layer. It must fail silently (no audio support / blocked autoplay → no error, game unaffected) and the mute state is a per-session UI toggle, not persisted.

5. **Perf budget for the richer scene** — _decided jointly with the spike:_ the spike measures FPS on a typical booth laptop (integrated graphics / Intel Iris class) and the chosen direction must hold **~60fps** there. Concrete guardrails for the build: far parallax layers cast **no shadows**; keep added per-zone draw calls modest; shadow-map resolution unchanged from today. Final layer count/animation is set by whichever spike variation Tom picks, under the 60fps-on-integrated-graphics bar.

**Author's calls (sensible-builder decisions):**

6. **Disable param name `nogame`, stored key `appSpaceGameDisabled`** — kiosk-obvious, matches "disable this feature per machine easily." Precedence rules as specified above. All disable/gate logic lives in `feature.ts` (new `getDisabledState()` read+write helper), called as the **first gate** in `AppSpaceGame.vue` `onMounted`, before `isWebGLAvailable()` and before the Three.js dynamic import.

7. **Obstacles/pits are procedural, deterministic, data-derived-but-not-data-driven** — the payload has no obstacle field and we hold zero-backend-changes. Deterministic placement (seeded from zone/coin layout) so the geometric-gap completability test is reproducible.

8. **Touch jump = tap-duration threshold (~120ms), not swipe-up.** A `pointerup` within ~120ms of `pointerdown` = jump; a longer hold = run (left half = left, right half = right) by `clientX`. Simpler and more reliable than swipe-delta tracking; matches mobile-platformer convention. Player hint updates to "Tap = jump · Hold left/right = move."

9. **HUD = DOM `<div>` in the Vue overlay** (reactive `ringCount` ref), not a second canvas — composites above the Three.js canvas with no extra GPU pass. The hit scatter is a **CSS shake/flash** on the counter plus a brief "−N rings!" DOM toast at Kasimir's screen position (~800ms); **no flying 3D ring particles** (avoids a new particle system).

10. **Label anti-overlap = fix root cause + height stagger.** Size the label texture to measured text (+padding), cap world-scale to that width, then stagger label height ±~0.4 units on even/odd coin index. **Do not change coin spacing** (4.5u) — it indirectly drives gate/goal X positions and `totalLen`; changing it would force re-testing goal-hit detection.

11. **Autopilot watchdog.** Track `lastProgressTime` (last time `kasX` advanced > ~0.5u). If autopilot makes no forward progress for **> 3s**, force progress (teleport `kasX` past the stuck point, reset physics) — the hard guarantee behind "never wedges," on top of the normal respawn-on-fail. 3s lets a respawn animation finish but never visibly freezes the kiosk.

## Goals

- The arcade **feels like a game**: obstacles stop you, pits catch you, a botched jump has a visible cost, and you can move both ways.
- **Light challenge, never difficult, never a game-over** — anyone at the booth can get through; the run always continues.
- **Autopilot plays the same game**, attempts obstacles, may fail occasionally, and **always self-recovers** — the kiosk never wedges.
- **Readable** labels at booth distance; no cutoff or overlap.
- A **richer, less-boring** scene that reads with depth and color across a crowded room.
- **Ring pickup feedback + a live HUD count**, purely ephemeral.
- **Per-machine disable** via URL param, remembered locally, no redeploy.
- Everything stays **zero-backend, flag-gated, fail-safe to the grid**.

## Non-goals

- Not a scored game. No persistence, no leaderboard, no gameboard/points integration, no per-user storage. Ring count never leaves the overlay.
- Not lives/levels/enemies/health-bars/game-over. One continuous forgiving run.
- No obstacle/pit data in the App-Space contract; no backend or CDS changes.
- No commissioned art; reuse existing Kasimir PNGs.
- Not a change to the grid's canonical login/pick/launch role — still the entry layer, still hands off.
- Not a rewrite of the original design — additive only.

## Anti-goals (failure even if it "works")

- **The kiosk gets stuck** — autopilot wedged on an obstacle/pit, or an unclearable layout, or a respawn that doesn't recover. This is the single most important thing to get right; Tom stated it twice.
- **Impossible / too-hard layout** — a jump a human can't make, or obstacles so dense the run stalls. "Shouldn't be difficult."
- **Progress misrepresentation** — obstacles/pits/score must not look like they reflect real tutorial progress or standing (they're decoration).
- **Breaking the grid** when the game is off, disabled, or unsupported.
- **Score leaking to the real page or backend** — it must stay ephemeral.
- **Still-unreadable labels** after the fix, or a scene that janks / overheats an all-day booth machine.

## Constraints

- Feature flag `APP_SPACE_GAME_ENABLED` (DB, default OFF, DEV-only) unchanged; new disable layered on top.
- Zero changes to CAP services, HANA model, `getAppSpaceProgress`/CDS return type, publish pipeline.
- Must bundle through the existing `hugo-apps` Vite build; Three.js stays dynamically imported / code-split so non-App-Space pages aren't bloated. Island-manifest/hashing (`build:all`) must ship correct hashed JS/CSS.
- Reuse existing Kasimir art (`hugo/static/images/devtoberfest/selfie/thumbnails/Kasimir_*.png`, `app/display-app-drawings/public/kasimir-tuxedo.png`).
- WebGL2 preferred, graceful degradation / fallback-to-grid when absent; respect `prefers-reduced-motion` (today it suppresses attract entirely — keep that behavior).
- PROD event cutover end of July 2026; this is additive and flag-gated, so it bakes on DEV without date pressure.
- Targets DEV via PR (feature PRs target DEV, not main).

## Left to the builder / plan

- Physics design: collision resolution against solid obstacles (block horizontal, allow land-on-top), pit detection, gravity/jump arc tuning so a human and the autopilot clear the same gaps.
- The **autopilot obstacle AI**: jump-timing heuristic, acceptable failure rate, and the guaranteed self-recovery / never-wedge mechanism (including a hard watchdog that forces progress if recovery somehow stalls).
- Procedural obstacle/pit placement algorithm: deterministic, light density, provably-completable path; where tests assert completability.
- Respawn logic: tracking "last safe ground" and the tumble→respawn choreography for both human and autopilot.
- Ring model: collect/scatter/reset arithmetic, how many rings a hit costs, the HUD overlay rendering, pickup feedback (visual, and whether to add optional sound).
- Label system rebuild: measurement, wrapping/ellipsis, resolution, anti-overlap spacing/stagger.
- Scene polish: concrete parallax layer design, set-dressing, improved flag/chest geometry, per-zone color propagation — within perf budget.
- Two-way input: keyboard + touch scheme, sprite facing/flip, world bounds, updated player hint text.
- Disable param: exact precedence implementation, `localStorage` read/write, and gating it ahead of the Three.js dynamic import in `feature.ts`/`AppSpaceGame.vue`.
- Test plan against the existing `__tests__/` suites for every deterministic piece above.

## Prior art in-repo (reference)

- The original Kasimir Arcade (this island) as shipped on DEV — the thing being enhanced.
- `hugo-apps/src/devtoberfest/CatGame.vue`, `hugo-apps/src/ktt/components/KasimirStage.vue` — earlier Kasimir games/animations; reference only.
