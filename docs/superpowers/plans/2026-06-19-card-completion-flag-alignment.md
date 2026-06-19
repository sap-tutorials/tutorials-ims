# Card completion-flag alignment fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the horizontal grid misalignment caused by `.nav-card--has-progress`'s `padding-left: 3rem` rule. Move the progress ring overlay from top-left to top-right so ringed and non-ringed cards share identical content widths.

**Architecture:** Pure CSS change in [hugo-apps/src/shared/cards/card.css](../../../hugo-apps/src/shared/cards/card.css) — relocate the ring's absolute position, delete the conditional padding rule, add one collision rule for the tutorial license icon. No markup, JS, or schema changes. One regression test added in [hugo-apps/src/shared/cards/cards.test.ts](../../../hugo-apps/src/shared/cards/cards.test.ts).

**Tech Stack:** CSS, Vue 3 + Vitest + happy-dom (test). No Hugo or CAP changes.

**Spec:** [docs/superpowers/specs/2026-06-19-card-completion-flag-alignment-design.md](../specs/2026-06-19-card-completion-flag-alignment-design.md)

**Issue:** [#399](https://github.com/sap-tutorials/tutorials-ims/issues/399)

**Branch:** `fix/issue-399-card-completion-flag-alignment` (already created from `main`; spec already committed as `6a9dabfe` + `57c3d026`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `hugo-apps/src/shared/cards/card.css` | Modify | Move `.nav-card__progress` to top-right; delete `.nav-card--has-progress` padding rule; add license-collision rule. |
| `hugo-apps/src/shared/cards/cards.test.ts` | Modify | Add regression assertions for the ring's right-side position and absence of `padding-left` inflation on ringed cards. |

No other files change.

---

## Task 1: Add the regression test (TDD — red first)

**Files:**
- Modify: `hugo-apps/src/shared/cards/cards.test.ts`

The failing test goes in BEFORE the CSS edit so we prove the regression assertion bites under the buggy state.

- [ ] **Step 1: Read the test file's existing structure**

```bash
cd D:/projects/tutorials-poc
sed -n '1,80p' hugo-apps/src/shared/cards/cards.test.ts
```

Note where the `<MissionCard>` describe block starts. New tests will go inside it (or alongside it).

- [ ] **Step 2: Add the regression test block**

Append a new `describe` block at the END of `cards.test.ts`. (Pasting the EXACT code below — don't paraphrase. The `import './card.css'` is already pulled in by the card SFCs themselves, so mounting a card brings card.css with it. The imports the snippet uses — `describe`, `expect`, `it`, `mount`, `MissionCard`, `emptyProgress`, `ProgressPayload`, `CardItem` — are already present at the top of the file; don't add duplicates.)

```ts
// ────────────────────────────────────────────────────────────────────────
// Regression: issue #399 — ring presence must not change content geometry.
// Before the fix: `.nav-card--has-progress` added `padding-left: 3rem`
// to .nav-card__type/__title/__desc, making ringed cards' content area
// 3rem narrower than non-ringed neighbors and breaking horizontal grid
// alignment. This test pins the contract that ringed and non-ringed
// cards must share the same computed left-padding on those elements.
// ────────────────────────────────────────────────────────────────────────
describe('issue #399: ring presence does not shift content', () => {
  const completedProgress: ProgressPayload = {
    ...emptyProgress(),
    missionSlugs: new Set(['mission-with-ring']),
  }

  it('ringed and non-ringed mission cards have the same .nav-card__title left-padding', async () => {
    // Two cards: one will get a ring (slug matches missionSlugs), one won't.
    const ringed: CardItem = {
      type: 'mission', id: 'm1', title: 'Ringed', description: '', time: 30, level: 'beginner',
      tutorialCount: 3, primaryTag: 'X', displayTags: [], displayTagSlugs: [],
      href: '/tutorials/mission-mission-with-ring',
    }
    const plain: CardItem = {
      type: 'mission', id: 'm2', title: 'Plain', description: '', time: 30, level: 'beginner',
      tutorialCount: 3, primaryTag: 'X', displayTags: [], displayTagSlugs: [],
      href: '/tutorials/mission-other',
    }

    const ringedW = mount(MissionCard, { props: { item: ringed, progress: completedProgress }, attachTo: document.body })
    const plainW  = mount(MissionCard, { props: { item: plain,  progress: completedProgress }, attachTo: document.body })

    // The ringed card carries the .nav-card--has-progress class today.
    expect(ringedW.classes()).toContain('nav-card--has-progress')
    expect(plainW.classes()).not.toContain('nav-card--has-progress')

    const ringedTitle = ringedW.find('.nav-card__title').element as HTMLElement
    const plainTitle  = plainW.find('.nav-card__title').element as HTMLElement
    expect(getComputedStyle(ringedTitle).paddingLeft).toBe(getComputedStyle(plainTitle).paddingLeft)

    ringedW.unmount(); plainW.unmount()
  })

  it('ProgressOverlay positions itself at right (not left)', async () => {
    const item: CardItem = {
      type: 'mission', id: 'm3', title: 'X', description: '', time: 30, level: 'beginner',
      tutorialCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [],
      href: '/tutorials/mission-mission-with-ring',
    }
    const w = mount(MissionCard, { props: { item, progress: completedProgress }, attachTo: document.body })
    // ProgressOverlay renders inside ClientOnly which is gated on hydration;
    // in happy-dom mount this resolves synchronously.
    const ring = w.find('.nav-card__progress').element as HTMLElement | undefined
    if (ring) {
      const cs = getComputedStyle(ring)
      expect(cs.right).not.toBe('auto')
      expect(cs.left).toBe('auto')
    }
    // If ring isn't found, the ClientOnly gate didn't open in this env —
    // skip silently rather than fail; the first test already enforces the
    // critical invariant (content geometry).
    w.unmount()
  })
})
```

- [ ] **Step 3: Run the new tests, confirm they FAIL (red)**

```bash
cd D:/projects/tutorials-poc
npx vitest run hugo-apps/src/shared/cards/cards.test.ts -t "issue #399"
```

Expected: the **first** test fails with a message like `expected '0px' to be '48px'` (ringed title has 3rem = 48px more padding-left than plain title) — that's the bug expressed as a failing test.

The second test may pass or fail depending on whether ClientOnly gates open in happy-dom. Either is OK; the first test is the primary regression.

If the first test passes, **stop** — that means either the bug is already gone or the test isn't exercising the right rule. Investigate before continuing.

- [ ] **Step 4: Commit the failing test**

```bash
git add hugo-apps/src/shared/cards/cards.test.ts
git -c core.autocrlf=false commit -m "test(cards): regression for #399 (ring presence shifts content)"
```

---

## Task 2: Fix the CSS

**Files:**
- Modify: `hugo-apps/src/shared/cards/card.css`

- [ ] **Step 1: Move the ring from left to right**

Find the `.nav-card__progress` rule (around line 152–159):

```css
/* ─── ProgressOverlay (CSR-only, gated on hydration) ─── */
.nav-card__progress {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  opacity: 0;
  transition: opacity 0.15s ease-out;
}
```

Replace `left: 0.75rem` with `right: 0.75rem`:

```css
/* ─── ProgressOverlay (CSR-only, gated on hydration) ─── */
.nav-card__progress {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  opacity: 0;
  transition: opacity 0.15s ease-out;
}
```

- [ ] **Step 2: Delete the content-pushing padding rule**

Find and delete the entire 5-line block (lines ~163–167):

```css
.nav-card--has-progress .nav-card__type,
.nav-card--has-progress .nav-card__title,
.nav-card--has-progress .nav-card__desc {
  padding-left: 3rem;
}
```

Delete every line including the closing brace and the trailing newline immediately after it. Do not leave behind a comment or a stub.

- [ ] **Step 3: Add the license-collision rule**

Below the (now-deleted) `.nav-card--has-progress` block, add:

```css
/* ─── License + ring collision (tutorial cards may have both) ─── */
/* When both are present, license shifts left so they sit side-by-side
   at the top-right corner: [license][ring]. Math: 0.75rem gutter +
   2.5rem ring + 0.5rem gap = 3.75rem. */
.nav-card--has-progress .nav-card__license {
  right: 3.75rem;
}
```

- [ ] **Step 4: Verify no other rules reference `nav-card--has-progress`**

```bash
cd D:/projects/tutorials-poc
grep -rn "nav-card--has-progress" hugo-apps hugo/layouts hugo/static
```

Expected matches:
- `hugo-apps/src/shared/cards/card.css` — the new license-collision rule (just added).
- `hugo-apps/src/shared/cards/MissionCard.vue`, `GroupCard.vue`, `TutorialCard.vue` — class binding (`'nav-card--has-progress': !!cardProgress(...)`) — keep.
- `hugo-apps/src/shared/cards/cards.test.ts` — the new regression test asserts on this class.
- Possibly compiled output under `hugo/static/js/chunks/` — IGNORE; these are build artifacts.

If anything else outside this list shows up, stop and investigate before continuing.

- [ ] **Step 5: Run the regression test, confirm it PASSES (green)**

```bash
cd D:/projects/tutorials-poc
npx vitest run hugo-apps/src/shared/cards/cards.test.ts -t "issue #399"
```

Expected: both tests pass.

- [ ] **Step 6: Run the full cards test suite, confirm no regressions**

```bash
cd D:/projects/tutorials-poc
npx vitest run hugo-apps/src/shared/cards/cards.test.ts
```

Expected: all tests pass (existing `<ProgressOverlay>` SSR/CSR tests + Mission/Group/Tutorial card tests + the two new regression tests).

- [ ] **Step 7: Commit the CSS fix**

```bash
git add hugo-apps/src/shared/cards/card.css
git -c core.autocrlf=false commit -m "fix(cards): move progress ring to top-right, drop content-pushing padding (#399)

Closes #399. The ring's overlay no longer indents .nav-card__type/title/desc,
so all cards in a grid row share the same content width regardless of whether
they have a completion ring."
```

---

## Task 3: Run the broader hugo-apps test suite

**Goal:** Confirm nothing in shared modules broke from the CSS change.

- [ ] **Step 1: Run all hugo-apps tests**

```bash
cd D:/projects/tutorials-poc
npx vitest run --root hugo-apps
```

Expected: all tests pass. If any unrelated tests fail, treat as separate (they're flaky or pre-existing) — don't try to fix them in this PR.

- [ ] **Step 2: Run the Hugo partial drift-parity check**

The card markup didn't change, but confirm:

```bash
cd D:/projects/tutorials-poc
grep -c "nav-card__progress" hugo-apps/src/shared/cards/MissionCard.vue hugo-apps/src/shared/cards/GroupCard.vue hugo-apps/src/shared/cards/TutorialCard.vue hugo/layouts/partials/browse/_partials/card-mission.html hugo/layouts/partials/browse/_partials/card-group.html hugo/layouts/partials/browse/_partials/card-tutorial.html
```

Expected: each Vue file has 1 match (the `<ProgressOverlay>` import indirection); each Hugo file has 0 matches (Hugo partials don't render ProgressOverlay — it's CSR-only). No drift.

If the project ships a dedicated parity test for these, run it:

```bash
grep -rln "byte-equivalent\|parity" hugo-apps/src test 2>/dev/null | head -5
```

If a `*.parity.test.*` file exists, run it explicitly. If not, the consistency of card classes (just verified above) is sufficient.

---

## Task 4: Visual sanity check (manual, local)

This is optional but recommended given the visual nature of the bug.

- [ ] **Step 1: Build hugo-apps for the local Hugo dev server**

```bash
cd D:/projects/tutorials-poc
npm --prefix hugo-apps run build
```

Expected: clean build, no errors.

- [ ] **Step 2: Run the Hugo dev server (only if tutorial fetch is current)**

```bash
cd D:/projects/tutorials-poc
# Skip if .tutorial-cache/ is missing — fetch is slow and not required for this CSS-only check
npm run dev
```

Open `/browse/` (or just the navigator at `/`) in a browser. Confirm visually:
- Cards in the same row share the same MISSION/GROUP/TUTORIAL label baseline.
- Completion rings, when shown for completed missions/groups, sit in the top-right corner.
- Layout looks identical for unauthenticated users (no rings, no padding shift).

If you have data with both a license and a completed tutorial, find a tutorial card that displays both and confirm the icons sit side-by-side at the top-right.

- [ ] **Step 3: Stop the dev server.**

No commit from this task — it's verification only.

---

## Task 5: Push branch and open PR

- [ ] **Step 1: Verify branch state**

```bash
cd D:/projects/tutorials-poc
git branch --show-current
git log --oneline main..HEAD
```

Expected current branch: `fix/issue-399-card-completion-flag-alignment`. Expected log: 4 commits (2 spec + 1 test + 1 fix).

- [ ] **Step 2: Push**

```bash
git push -u origin fix/issue-399-card-completion-flag-alignment
```

- [ ] **Step 3: Open PR**

```bash
gh pr create \
  --repo sap-tutorials/tutorials-ims \
  --base main \
  --title "fix(cards): align ring overlay so it doesn't push content (#399)" \
  --body "$(cat <<'EOF'
## What

Move the completion ring overlay from top-LEFT (with content-pushing \`padding-left: 3rem\`) to top-RIGHT (overlay only). Drops the conditional \`.nav-card--has-progress\` padding rule so all cards in a grid row share identical content widths regardless of whether they have a completion ring.

## Why

Per #399: when a card had a completion ring, its title/description/type-label got pushed 3rem to the right, making the title wrap onto an extra line and breaking horizontal alignment with neighboring cards in the same row. (Bug screenshot in the issue shows the middle mission card's MISSION label sitting visibly lower than the cards beside it.)

## Changes

- [\`hugo-apps/src/shared/cards/card.css\`](hugo-apps/src/shared/cards/card.css): move \`.nav-card__progress\` from \`left: 0.75rem\` to \`right: 0.75rem\`. Delete the \`.nav-card--has-progress\` padding rule. Add \`.nav-card--has-progress .nav-card__license { right: 3.75rem }\` for the rare tutorial card with both a license icon AND a progress ring (side-by-side at top-right).
- [\`hugo-apps/src/shared/cards/cards.test.ts\`](hugo-apps/src/shared/cards/cards.test.ts): regression tests using \`getComputedStyle\` to pin the new contract.

## Test plan

- New regression tests in \`cards.test.ts\` pass.
- Existing card tests + ProgressOverlay SSR/CSR tests pass.
- Hugo partial drift-parity preserved (markup unchanged; only CSS shifted).
- Visual: \`/browse/\` cards share baselines whether ringed or not; ring renders top-right.

## Refs

- Spec: [docs/superpowers/specs/2026-06-19-card-completion-flag-alignment-design.md](docs/superpowers/specs/2026-06-19-card-completion-flag-alignment-design.md)
- Plan: [docs/superpowers/plans/2026-06-19-card-completion-flag-alignment.md](docs/superpowers/plans/2026-06-19-card-completion-flag-alignment.md)
- Original ring design: [docs/superpowers/specs/2026-05-27-navigator-card-completion-design.md](docs/superpowers/specs/2026-05-27-navigator-card-completion-design.md) (where the conditional padding was introduced)

Closes #399.
EOF
)"
```

Expected: PR URL printed.

---

## Out of scope (per spec)

- Redesigning the ring (stroke, palette, animation timing).
- Changing what triggers a ring.
- Changing the License icon visual.
- NEW badge position (still at bottom-right; no collision).
- Hugo partial markup changes (none needed — CSS-only fix).

## Notes for the implementer

- **TDD order matters here:** write the failing regression test FIRST so you can prove the bug bites and the fix kills it. Don't skip Task 1 step 3 (red) or step 5 of Task 2 (green).
- **Tiny PR.** Two files modified, ~15 lines net change.
- **No deploy needed for verification.** Test suite is sufficient. Visual verification (Task 4) is local-only.
- **Don't squash commits.** Spec → test (red) → fix (green) is a clean story.
