# Card completion-flag alignment fix — design

**Issue:** [#399](https://github.com/sap-tutorials/tutorials-ims/issues/399) — Completion Flag is throwing off the alignment of the rest of the content in a card

**Date:** 2026-06-19

## Problem

When a navigator/browse card has a completion ring (`ProgressOverlay`), the card adds `padding-left: 3rem` to its TYPE label, title, and description (rule at [hugo-apps/src/shared/cards/card.css:163–167](../../../hugo-apps/src/shared/cards/card.css#L163-L167)). Cards in the same grid row that don't have a ring don't get this padding, so:

- Ringed cards have a narrower content area than their neighbors.
- Titles that would fit on one line wrap to two (the bug screenshot shows "SAP BTP ABAP Environment: Level Up" wrapping under the squeeze).
- Each extra wrapped line pushes the meta and tag rows down, breaking the horizontal baseline shared by neighboring cards.

Visual evidence: the ringed middle card's MISSION label and title sit visibly lower than the same elements on the two cards beside it.

## Goal

Cards in the same grid row share identical content widths and horizontal baselines, regardless of whether any individual card has a completion ring. The ring stays as a CSR-only overlay that's purely decorative — its presence must not change content-area geometry.

## Approach

**Move the ring from top-LEFT (with content-pushing padding) to top-RIGHT (overlay only, no content shift).** This puts the ring in the empty top-right gutter that already exists on every card and removes the need for `padding-left` on ringed cards.

### Changes

1. **[hugo-apps/src/shared/cards/card.css](../../../hugo-apps/src/shared/cards/card.css)**
   - **Move `.nav-card__progress`** from `left: 0.75rem` to `right: 0.75rem` (keep `top: 0.75rem`).
   - **Delete** the three-selector `padding-left: 3rem` rule at lines 163–167. Title/desc/type-label go back to flowing from the natural card padding edge on every card.
   - **Add license collision rule:** `.nav-card--has-progress .nav-card__license { right: 3.5rem; }` — when a tutorial card has both a license icon AND a progress ring, the license shifts left so the two sit side-by-side at the top-right corner: `[license][ring]`.

2. **No markup changes.** [MissionCard.vue](../../../hugo-apps/src/shared/cards/MissionCard.vue), [GroupCard.vue](../../../hugo-apps/src/shared/cards/GroupCard.vue), [TutorialCard.vue](../../../hugo-apps/src/shared/cards/TutorialCard.vue), and the three Hugo mirror partials at [hugo/layouts/partials/browse/_partials/card-*.html](../../../hugo/layouts/partials/browse/_partials/) stay byte-equivalent. The drift-parity test (existing) keeps passing.

3. **No JS changes.** `cardProgress()` semantics, `ProgressPayload` shape, and `nav-card--has-progress` class application are unchanged.

4. **Test additions in [hugo-apps/src/shared/cards/cards.test.ts](../../../hugo-apps/src/shared/cards/cards.test.ts):**
   - Add a regression assertion that the `padding-left: 3rem` rule no longer exists. Implement as a string check on the imported card.css contents OR a getComputedStyle assertion on a mounted ringed card (no left-padding inflation).
   - Confirm `.nav-card__progress` resolves to a position with `right` set (not `left`).

5. **No spec drift on Hugo partials.** Card markup is unchanged; only its CSS shifts. The "markup MUST be byte-equivalent" parity invariant in the partial header comments is preserved.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **Ring at top-right, drop padding-left** (this design) | Zero dead-zone for the 99% case (no progress). Two/three CSS rules total. No markup change. License collision handled with one extra selector. | Tutorial cards with both license + ring need a side-by-side layout (resolved by extra rule). | **Chosen** |
| Reserve 3rem padding-left on EVERY card (drop the conditional selector) | Bulletproof grid alignment with one CSS deletion. | Visible 3rem dead-zone on the left of every card across `/`, `/browse/`, and rail variants — affects every browse view for unauthenticated users and users with no progress yet. Cosmetic regression. | Rejected |
| Shrink the ring + smaller padding-left | Minimal CSS change. | Doesn't fix the alignment problem — just reduces its severity. Still has variable content widths between ringed and non-ringed cards. | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| Tutorial with both license icon AND progress ring | License icon overlaps ring at top-right | The `.nav-card--has-progress .nav-card__license { right: 3.5rem; }` rule shifts the license left. Both visible side-by-side: `[license 14px][ring 2.5rem]`. |
| Ring + NEW badge | NEW badge is at bottom-right ([card.css:31–44](../../../hugo-apps/src/shared/cards/card.css#L31-L44)) — different corner; no collision. | None. |
| Ring + category-chip (`ui5-tag`) | Category chip is at end of card flow (no positioning); ring is absolute. No collision. | None. |
| `padding-left: 3rem` regression sneaking back | Visible misalignment returns | Caught by the regression test (Task 4). |

## Out of scope

- Redesigning the ring itself (stroke width, palette, animation timing).
- Changing what triggers a ring (still: completed tutorial, completed mission, completed group, in-progress tutorial >0%).
- Changing License icon visual.
- Changes to NEW badge position.
- Animation polish on ring entry — existing 0.15s fade-in stays.

## Verification

After the fix is applied locally and built (`npm run dev`):

1. Navigate to `/browse/`. As an authenticated user with at least one completed mission/group/tutorial:
   - All cards in any row share identical content widths.
   - All cards' MISSION/GROUP/TUTORIAL labels sit on the same baseline.
   - All titles wrap (or don't) the same way regardless of whether the card has a ring.
   - Ring is visible in the top-RIGHT corner of completed cards.

2. As an unauthenticated user (no progress data):
   - No rings render anywhere (gated by `cardProgress()` returning null).
   - Layout is identical to before this fix (no dead-zone added).

3. On a tutorial card that has both a license AND progress:
   - License icon and ring sit side-by-side at the top-right, license on the left of the ring.

4. Hugo partial parity test (existing) passes — Vue and Hugo card markup stay byte-equivalent.

5. Unit tests: existing `<ProgressOverlay>` SSR/CSR tests still pass; new regression test for the absent `padding-left` rule passes.

## References

- Bug: [#399](https://github.com/sap-tutorials/tutorials-ims/issues/399)
- Original ring design (where the conditional padding was introduced): [docs/superpowers/specs/2026-05-27-navigator-card-completion-design.md](../specs/2026-05-27-navigator-card-completion-design.md)
- Affected files: [hugo-apps/src/shared/cards/card.css](../../../hugo-apps/src/shared/cards/card.css), [hugo-apps/src/shared/cards/cards.test.ts](../../../hugo-apps/src/shared/cards/cards.test.ts)
- Related: [hugo-apps/src/shared/ProgressRing.vue](../../../hugo-apps/src/shared/ProgressRing.vue) (ring component, unchanged)
