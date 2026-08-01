# Devtoberfest Animated Gameboard (Arcade Scene) — Design

**Date:** 2026-08-01
**Status:** Approved (design), pending spec review → implementation plan
**Repo:** `tutorials-ims` (Hugo page + Vue island); consumes the deployed `sap-community-gameboard` backend.

## 1. Summary

Recreate the legacy Devtoberfest **animated arcade gameboard** — the event centerpiece
(legacy: `GET /devtoberfestContest/:scnId`, e.g. the CRT arcade with Kasimir the lobster,
sprites, and an avatar bouncing on level-clouds as points accrue) — on the new stack, as a
**separate app from the leaderboard**.

The existing leaderboard at `/devtoberfest/gameboard/` stays as-is. The animated scene is a
**new Hugo page + Vue island at `/devtoberfest/arcade/`**, driven by the logged-in user's
live tutorial-system data (no `scnId`), with an animated demo + register CTA for anonymous
visitors.

## 2. Goals & non-goals

**Goals**
- Faithful visual recreation of the legacy arcade scene (CRT cabinet, sprites, level clouds,
  avatar-on-cloud mechanic, hearts, banners) using the new stack.
- Driven by live data: the logged-in user's `level` / `avatarIndex` / `score` from the
  deployed `gameboard-srv` `getMyGameboard()`.
- Anonymous visitors see an animated demo board with a prominent "Join Devtoberfest" CTA
  (friendlier than the legacy "Not Registered" error) to drive registration.
- Maintainable: Vue island + CSS/sprite animation, static assets (not base64-embedded),
  optimized asset weight.
- Accessible: respects `prefers-reduced-motion`; audio muted by default.

**Non-goals**
- No `scnId`-based lookup — identity comes from the tutorial-system session (JWT). Arbitrary
  "view any user's board by id" is dropped.
- Not porting the legacy server-side SVG-string renderer (base64 bloat, arg-inversion quirks,
  ~30MB assets). Reinterpreted cleanly on the new stack, same visual result.
- Leaderboard is untouched (separate app, already live).
- Selfie-with-an-Advocate UI is a separate follow-up.

## 3. Key decisions (locked with stakeholder)

| Decision | Choice |
|---|---|
| Implementation | Vue island + CSS/sprite animation (not a server-side SVG renderer) |
| Location | New Hugo page + island at `/devtoberfest/arcade/` (sibling to the leaderboard) |
| Identity | Logged-in user via `getMyGameboard()` — **no scnId** |
| Anonymous state | Full animated demo board + "Join Devtoberfest to play" CTA overlay |
| Level mechanic | Faithful: avatar on the level-cloud matching level 0–4; bounce iteration = level; hearts = level |
| Audio | `8bit.mp3` with a toggle, **muted by default**, no autoplay |
| Assets | Referenced sprites only (skip unused `*Old`/promo/thumbnails), heavy ones optimized |

## 4. Architecture

Same page-island pattern as the existing `/devtoberfest` and `/devtoberfest/gameboard`
surfaces — **no new MTA module or approuter route** (served by the existing static
catch-all; data via the already-routed `/gameboard/*`).

```
Browser ─▶ tutorial approuter
   /devtoberfest/arcade/           → Hugo static page (island mount)
   /js/arcade.js                    → the Vue island bundle
   /images/devtoberfest/arcade/*    → sprite/avatar/audio/font assets (static)
   /gameboard/getMyGameboard()      → gameboard-srv (level, avatarIndex, score) [logged-in]
```

**Files (tutorials-ims):**
- `hugo/content/devtoberfest/arcade/_index.md` — Hugo content.
- `hugo/layouts/devtoberfest/arcade.html` — layout with `<main id="arcade-mount" data-api-*>`
  mount node + `<noscript>` fallback + `<script type="module" src="/js/arcade.js">`.
- `hugo-apps/src/arcade/` — the island: `main.ts` (reads mount + data attrs, mounts Vue),
  `Arcade.vue` (scene orchestrator + data fetch/fail-soft), `scene/` sprite-layer components,
  `types.ts`, `styles.css` (ported keyframes), `useSound.ts`, `__tests__/`.
- `hugo-apps/vite.config.ts` — new entry `arcade: resolve(__dirname,'src/arcade/main.ts')`.
- `hugo/static/images/devtoberfest/arcade/` — carried + optimized assets.

## 5. The scene

Recreates the legacy paint-order composition as positioned sprite layers (CSS-positioned
`<img>`/`<div>`, not one big SVG string). Layers (back→front):

1. CRT cabinet frame (`BackgroundOKG`) + bottom bezel (`okBottom`).
2. Title art (`Group_13`).
3. Main sky/progress area (`clouds/Group_12a`).
4. The **4 level clouds/waypoints** (Level 1, 2, 3, "Nerdvana"/4) — banners + hearts sprites
   + level labels, fixed positions.
5. Ambient animated sprites: drifting cloud, yellow lobster (Kasimir), red alien, green
   runner (GIFs kept animated), Devtoberfest logo GIF, SAP logo.
6. **The user's avatar** on its level-cloud (see §6).
7. HUD: points/level banner ("POINTS: X LEVEL: N"), "How to Play" + "Making the Lawyers
   Happy" text columns, blinking LED, stars, sound toggle.

**Canvas:** the legacy 1347×1612 aspect, made responsive (scale-to-fit container) rather
than a fixed pixel canvas.

**Animation** (CSS keyframes ported from `devtoberfestSVG.css` / `devtoberfest.css`):
`fadeInAnimation` staggered boot-up, `bounce-7` avatar bounce, `beat` heart pulse,
`blinkGreen` LED, and transform-based drifts for the lobster/alien/cloud (replacing the
legacy inline SVG `<animate>`). All motion gated by `@media (prefers-reduced-motion: reduce)`
→ static.

## 6. Level → avatar mechanic (faithful)

From `getMyGameboard()` → `{ level (0–4), avatarIndex (0–37), score }`:
- Avatar image = `avatars/Group-<avatarIndex>.png`, clamped 0–37.
- Placed on the **level-cloud matching `level`** at the legacy per-level coordinates.
- **Bounce iteration count = level** (level 4 = infinite bounce); **hearts drawn = level**.
- Banner shows live `score` + `level`.

Legacy per-level avatar coordinates (from recon; adapted to the responsive container):

| level | placement | bounce | hearts |
|---|---|---|---|
| 0 | start cloud | `avatar-1` | 0 |
| 1 | cloud 1 | `avatar-1` | 1 |
| 2 | cloud 2 | `avatar-2` | 2 |
| 3 | cloud 3 | `avatar-3` | 3 |
| 4 | Nerdvana | `avatar-4` (∞) | (server lights) |

## 7. Anonymous state

If `getMyGameboard()` returns 401 / no session: render the **full animated demo** — a sample
avatar on the board, all ambient sprites animating, level clouds shown — with a prominent
**"Join Devtoberfest to play"** CTA overlay linking to the Devtoberfest join/registration
flow. No real data; never an error. This is also the **fail-soft** state if the API errors.

## 8. Audio

Carry `8bit.mp3`. A sound toggle (legacy menu-icon style) starts **muted**; no autoplay
(browser-blocked + accessibility). User opts in.

## 9. Assets

Carry only the sprites the live legacy board references into
`hugo/static/images/devtoberfest/arcade/`: CRT frame + bezel, title, `clouds/*` (Kasimir,
lobster, aliens, runner, drifting cloud, progress area), the 4 level cloud banners + hearts,
`menu/*`, `levels/*` referenced sprites, `avatars/Group-0..37.png`, `stars`, the Devtoberfest
+ SAP logos, `8bit.mp3`, and `joystix_monospace.ttf`. **Skip** the unused `*Old`, promo, and
`Originals/` files. **Optimize** the heavy PNGs (several avatars + backgrounds are 1–12 MB) so
total page weight is reasonable. (The 38 avatars already committed for the leaderboard's
`CabinetFrame` at `hugo/static/images/devtoberfest/avatars/` can be **reused** — don't
duplicate; optimize those in place.)

## 10. Testing

- **Unit** (`hugo-apps`, vitest): scene renders expected layers; `avatarIndex→Group-<n>.png`
  mapping; level→cloud-position + bounce-class mapping (0–4); anonymous/401 → demo+CTA;
  `prefers-reduced-motion` disables animation; audio starts muted.
- **e2e** (committed Playwright, self-skips without base URL): `/devtoberfest/arcade/`
  renders the cabinet + a demo avatar anonymously.
- **Verification-before-done:** load `/devtoberfest/arcade/` in a browser on DEV and confirm
  the animated scene renders (anonymous demo state, since no participants yet).

## 11. Rollout

Pure tutorials-ims frontend change (island + assets). Deploys with the standard
`npm run deploy -- --env dev` (Hugo build + approuter). No backend/MTA/route changes; consumes
the already-deployed `/gameboard/getMyGameboard`.

## 12. Open questions / risks

- **Avatar/asset weight** — even optimized, 38 avatars + the CRT background are the page's
  bulk; lazy-load non-critical sprites and serve the avatar on demand by index.
- **Responsive fidelity** — the legacy was a fixed 1347×1612 canvas; scaling to fit while
  keeping sprite placement faithful needs care (a scaled coordinate system, not per-breakpoint
  re-layout).
- **Demo avatar choice** — pick a fixed sample `avatarIndex` for the anonymous state (e.g. a
  recognizable one) rather than random, for a consistent teaser.
