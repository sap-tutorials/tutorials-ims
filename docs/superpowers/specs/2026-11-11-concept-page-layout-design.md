# Concept / topic / channel page layout fixes (issue #3095)

**Date:** 2026-11-11
**Issue:** [#3095 — Layout of concept pages](https://github.com/sap-tutorials/tutorials-ims/issues/3095)
**Branch target:** DEV (feature PR → DEV, per repo branching model)
**Branch:** `fix-concept-page-layout-3095`

## Intent and the why

A reporter filed #3095: on concept **detail** pages "the layout of the content /
tiles looks like some space between the end of the page / browser and the content
is missing" — content sits **flush against the left browser edge**, hard to read.
Tom confirmed the left-flush reading problem and, during investigation, pointed
out `/channels/` has the same issue.

Investigation (this session, two audit passes) found this is **one root-cause bug
class** affecting four pages, plus a separate content-density problem:

### Bug class A — missing root width/padding (flush-left)

CAP serves these page bodies spliced into a **bare `<main>`** at the shell's
`<!-- MAIN -->` marker (`composeShell` is pure string concatenation — no shared
container, no padding, no max-width). The site has **no global container class**;
by convention **each body's root element class must carry its own
`max-width + margin:0 auto + padding`**. Four pages forgot, so they render
flush-left:

| Page | URL | Root class | Renderer | Serve path |
|---|---|---|---|---|
| Concept detail | `/concepts/<slug>/` | `.concept-page` | `srv/lib/templates/concept-detail.ejs:1` (`<article>`), via `concept-detail-render.js:81` | CAP |
| Topic detail | `/topics/<slug>/` | `.topic-detail` | `srv/lib/topic-detail-render.js:56` | CAP |
| Channel detail | `/channels/<slug>/` | `.channel-detail` | `packages/channels/channel-detail-render.js:53` | CAP |
| Channels index | `/channels/` | `.channels-page` | `hugo/layouts/channels/list.html:3` | **Hugo-static** |

None of these four classes has a base rule in the CSS source, and none ships an
inline `<style>` fallback. All four flush-left.

**Not bugs (already safe):** `.concepts-index` (`concept-list-page.js:133`) and
`.topics-index` (`topic-list-page.js:53`) have no CSS-file rule but DO ship their
own inline `<style>` with width+padding. `.group-body`/`.mission-body` have a
PRESENT rule (`max-width:1280px; margin:0 auto; padding:1.5rem 2rem 3rem`).

### Bug B — unbounded relationship lists ("not 100% ready")

Every relationship section in `concept-detail.ejs` renders with a bare `.forEach`
— no cap, no collapse. Hub concepts dump hundreds of tiles: `sap-btp-fundamentals`
renders **235** "Concepts that build on this" tiles. A wall of hundreds of cards
is the most likely cause of the reporter's vague "looks not like it is 100% ready"
remark. Leaf concepts (e.g. `cap-golden-path-best-practices`, single-digit lists)
look fine — which is why the problem is intermittent and hard for the reporter to
pin down.

Why now: #3095 is an open user-facing feedback item on PROD pages ahead of the
end-of-July-2026 PROD cutover.

## CRITICAL build-system fact

The `.concept-page__*` rules live in **`hugo/assets/css/sap-fundamental.src.css`**
(git-tracked SOURCE). The minified `hugo/assets/css/sap-fundamental.css` is a
**build output, gitignored since #2896** — `build:css` runs postcss
(`src.css → sap-fundamental.css`). **All CSS edits go in `.src.css` only.** Editing
the built file causes Hugo-fingerprint drift vs the rebuild path and blocks content
publish. (`package.json:81` `build:css`; `scripts/sync-approuter-css.cjs`.)

## Goals

- All four flush-left pages get comfortable left/right breathing room and a
  sensible max content width, consistent with the rest of the site.
- Hub concepts no longer dump hundreds of relationship tiles; long sections cap
  at N with a no-JS affordance to reveal the rest.

## Non-goals

- `.concepts-index` / `.topics-index` — already safe via inline style.
- `.group-body` / `.mission-body` — already have the rule.
- Redesigning page IA, card visuals, or the KG relationship model. Layout/polish
  only, not a redesign.
- Changing which relationships/links are shown, their ranking, or ordering.
- Homepage `/` flip or any other content-flip work.

## Anti-goals (failure even if it "technically works")

- A **new global container class** or a `main { max-width }` rule — would silently
  reflow every other CAP-served page. Scope strictly to the four named root classes.
- Editing the **built** `sap-fundamental.css` instead of `.src.css` (fingerprint
  drift → blocked publish).
- Capping relationship lists so hard that useful links become unreachable, or
  hiding the total count so users can't tell more exist.
- A JS-only "show more" that still ships all 235 tiles in the initial visible DOM
  (no polish win, breaks no-JS). The cap must move the overflow into a collapsed
  element server-side.

## Constraints

- **CSS fix (bug class A) needs NO body re-publish** — CSS is served separately
  (`/css/sap-fundamental.css`), regenerated from `.src.css` by the build. A deploy
  that ships the rebuilt CSS is enough for all four pages, including the
  Hugo-static channels index (it references the same stylesheet).
- **Template cap (bug B) IS a body-bytes change** in `concept-detail.ejs` →
  requires a **concept re-publish** (`rebuild-content.yml` concepts render-set)
  after deploy to take effect on served BLOBs, not a deploy alone.
- No-JS-resilient: collapse via CSS-only `<details>`/`<summary>`, no island, no JS.
- Horizon theme tokens (`var(--sap…)`) for any new visible chrome; match the
  sibling `.group-body` / `.concepts-index` rules.
- Windows worktree: CSS/EJS files are LF — verify with `file <path>` after edits,
  normalize any CRLF flip before commit.

## Decisions made (settled "how")

- **Detail/page width = 1280px** (Tom's call), matching `.group-body`/`.mission-body`
  (`max-width:1280px; margin:0 auto; padding:1.5rem 2rem 3rem`) rather than the
  960px index. Applied to all four root classes for site consistency:
  ```css
  .concept-page,
  .topic-detail,
  .channel-detail,
  .channels-page { max-width: 1280px; margin: 0 auto; padding: 1.5rem 2rem 3rem; }
  ```
  (One grouped rule or four rules — builder's style call; grouped is fine. Placed
  near the existing `.concept-page__*` block in `sap-fundamental.src.css`.)
- **Mobile parity = TWO rules, not one.** `.group-body`/`.mission-body` also have a
  mobile override (`@media` block, `sap-fundamental.src.css:2774-2777`:
  `padding: 1rem`). For true sibling parity the four classes must be added to BOTH
  the desktop rule AND that mobile media-query block — otherwise phones get 2rem
  side padding vs the siblings' 1rem. (Resolved from builder-check Q1.)
- **Relationship cap mechanism = CSS-only `<details>` collapse.** Render the first
  N tiles always-visible; the remainder inside a `<details>` whose `<summary>` shows
  the total, e.g. "Show all 235". No island, no JS.
- **Cap scope (resolved from corpus data) = KG-relationship sections only.** A live
  sample of the concept corpus shows only **"Concepts that build on this"
  (`requiredBy`)** balloons (235, 20, 11, 7, 5 across samples); every other
  section — tutorials, learning journeys, docs, videos, samples, prerequisites,
  missions — stays single-digit to low-teens. So cap the KG-relationship sections
  (`requiredBy`, `relatedTo`, `requires`, `teaches`) and leave the naturally-small
  phase-4 external sections uncapped. In practice only `requiredBy` collapses
  anything on hub concepts; with N≈24 all sampled non-hub pages are untouched.
  (Resolves builder-check Q4/Q5.)
- **Padding fix = base rule on the existing root classes**, not a markup/wrapper
  change — matches the per-component convention, no body re-publish for class A.

## Left to the builder

- **Cap threshold N** — initial-visible count (data suggests ~24 keeps all sampled
  non-hub pages uncollapsed). Builder finalizes; document the chosen value.
- **`<summary>` copy + a11y label** and how the count is shown.
- **Channel detail (`.channel-detail`) tile lists** — the only list is "Topics
  covered" (`channel-topics__list`); builder confirms whether it can grow enough to
  warrant the cap (padding fix applies regardless). No corpus evidence it balloons.
- **Deploy/publish sequence** — CSS lands via deploy (fixes all four flush-left
  pages); the template cap needs a concepts re-publish after deploy. Builder
  confirms the rebuild mode and notes the two-step activation in the PR body.
  One PR recommended.
- **Verification (test the actual deployed thing):** curl the cited URLs after
  deploy+publish; confirm left padding present on all four and the big "build on
  this" section is collapsed; re-check against the #3095 screenshots.

## Resolved during builder-check (no longer open)

- **Q2 — channels index is a Vue island, does padding `.channels-page` fix it? YES.**
  The island root `.channels-directory` is only `display:flex; flex-direction:column;
  gap` — no width/margin/padding of its own (`ChannelsDirectory.vue:109`), so it
  fills its `.channels-page` host and padding the host pushes the whole grid inward.
  Single grouped rule suffices; no island override needed.
- **Q3 — channel detail emits a nested `<main>`** (`channel-detail-render.js:52`
  `<main><article class="channel-detail">`, which the shell then wraps in another
  `<main>` → `<main>`-in-`<main>`). Known structural oddity. Out of scope
  (layout/polish, not redesign); padding `.channel-detail` works regardless. Left
  as-is; flagged here so the builder doesn't "fix" it unprompted.

## Files in play

- `hugo/assets/css/sap-fundamental.src.css` — add grouped base rule for
  `.concept-page, .topic-detail, .channel-detail, .channels-page` (near the
  existing `.concept-page__*` block). **Source file only — never the built `.css`.**
- `srv/lib/templates/concept-detail.ejs` — cap relationship `.forEach` loops with
  the `<details>` collapse helper.
- (Possibly) `srv/lib/concept-detail-render.js` — small helper if the first-N/rest
  split is cleaner in JS than inline EJS.
- (Possibly) `packages/channels/channel-detail-render.js` — only if channel detail
  tile lists also need the cap.

## Deferred / separate

- The reporter's "not 100% ready" is treated as bug B (tile wall). If, after the
  fix, Tom or the reporter identifies a different specific defect, that's a new
  ticket — this PR does not chase the vague remark further.
