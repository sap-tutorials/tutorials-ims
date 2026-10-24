# App Space — `parallel-any` any-one prize + fork connector alignment (design delta)

> **STATUS: DEFERRED / NOT BUILT (2026-10-23).** Superseded by a product
> decision: the "N plain tutorials, any one → one *shared* prize" shape is not
> needed. For the driving event (`10000015`) the requirement is better served by
> authoring themed **fork lanes** with a per-lane prize (the already-shipped
> #2887/#2889 keystone — verified working), which keeps each prize behind a full
> branch of work. The physical prize ceiling (max 2) is enforced server-side at
> claim time (`PrizeRecords` CLAIMED, capped at 2) regardless of how many
> checkpoints unlock, so "don't make prizes too easy" is handled by branch-sized
> gating + the cap, not by a shared-prize any-of rule. Kept as a record in case a
> future event genuinely needs "any one of N → exactly one shared prize".
>
> **Delta on** [`2026-10-22-app-space-parallel-paths-design.md`](2026-10-22-app-space-parallel-paths-design.md)
> (the #2887/#2889 segments work). This doc adds ONE new behavior and ONE
> rendering fix; it does not re-open the decided data model. Target: `DEV`.

## 1. Intent (the why)

An event author wants a track that offers **N tutorials as free choices** and
awards **a single shared prize for completing any one of them**. Concretely
(live DEV event `10000015`, mission "Joule Studio — Create an Agent to claim
your prize"): 8 beginner tutorials shown "complete these in any order", one
checkpoint "Complete One of these to Claim Your Prize".

Today this is **not expressible**. Yesterday's design (`2026-10-22`) built two
reward shapes:

- **per-lane prize** — a `fork` lane (GROUP row) carrying its own `prize`
  (`§3`, keystone): completing *that branch* earns *that branch's* reward.
- **join prize** — a CHECKPOINT at a higher order after a fork: needs **all**
  lanes.

A cluster of plain tutorials sharing an `itemOrder` classifies as
`parallel-any` (`classifyPathSegments`: 2+ members, none GROUP). `parallel-any`
was spec'd as a pure **all-of setup gate** — "complete in any order" means
*order-free*, **not** *any-one*. So:

- Authoring the 8 as `parallel-any` + a downstream checkpoint → the checkpoint
  is gated by `isSegmentSatisfied(parallel-any) = items.every(complete)` →
  requires **all 8**. (This is exactly what the user observes: one done,
  prize still locked.)
- Authoring the 8 as a `fork` of single-tutorial GROUP lanes → gives **8
  separate per-lane prizes**, not one shared prize. The user explicitly
  rejected this.

**There is no current authoring that yields "N plain tutorials, any one, one
shared prize."** This delta adds exactly that.

## 2. Goals / non-goals / anti-goals

**Goal.** A CHECKPOINT-with-`prize` path-item placed at an `itemOrder`
immediately **after** a `parallel-any` cluster unlocks when **at least one**
member of that cluster is complete (strict `COMPLETED`, #2866/#2864 rules
intact). Authoring stays pure-placement: 8 TUTORIAL rows at one order + a
CHECKPOINT-with-prize at a higher order. No schema change, no new field.

**Non-goals.**
- "N of M" thresholds (complete 2 of 8). Out of scope; see §6 note.
- Changing fork / per-lane-prize / join behavior in any way.
- Any admin-UI authoring change (the Path Items editor already allows
  duplicate orders + CHECKPOINT+prize rows — verify, don't extend).

**Anti-goals (failure even if it "works").**
- The fork "Claim Your Prize after both branches" track (DEV event with two
  `Branch` lanes → join checkpoint) changing behavior at all. It must stay
  locked until **all** lanes complete. This is pinned by a regression test
  reproducing that exact screenshot.
- Any existing `parallel-any`-then-more-work track silently completing early.
  A `parallel-any` cluster that is **not** immediately followed by a
  prize-bearing checkpoint — i.e. one that gates a *further tutorial segment*
  — must keep requiring **all** members (so the next WORK segment and
  track-completion are unchanged).

## 3. The mechanism (decided)

The existing engine already proves the pattern: **fork lane prizes are
decoupled from `isSegmentSatisfied`** — they unlock via `isLaneTutorialsComplete`
(per-lane), independent of the fork's overall all-lanes satisfaction. We apply
the same decoupling to the cluster→prize edge.

`isSegmentSatisfied(parallel-any)` stays `items.every(isComplete)` — it
continues to gate (a) the next segment's unlock and (b) track completion.
**Unchanged.** This is what protects "cluster then more required work".

New: when `annotateUnlocked` sets the `unlocked` flag on a segment whose items
are **prize-bearing CHECKPOINTs** and whose **immediately-preceding** segment is
`parallel-any`, that checkpoint's unlock uses an **any-of** test over the prior
cluster — `priorCluster.items.some(isComplete)` — instead of `prevSatisfied`.

Precisely, in `annotateUnlocked`'s per-segment loop, compute the unlock input
for a checkpoint segment as:

- default: `prevSatisfied` (today's behavior), AND
- if the previous segment is `parallel-any` AND this segment contains a
  CHECKPOINT carrying a prize (`prizeId`/prize assoc): unlock that checkpoint
  on `previous.items.some(isComplete)`.

Plain (no-prize) checkpoints after a `parallel-any` keep `prevSatisfied`
(all-of) — only the **reward** is any-of, mirroring §3's "reward decoupled"
principle. A `parallel-any` with no following prize checkpoint is entirely
unchanged.

**Why not flip `isSegmentSatisfied` to `.some()`:** that single value feeds
next-segment unlock *and* track completion *and* the prize. Flipping it would
early-complete any "cluster then more work" track and contradict the locked-in
test `'cluster locks downstream until ALL members are COMPLETED'`. Decoupling
touches only the reward edge.

**Track completion (client `isTrackComplete`).** For this shape the prize
checkpoint is terminal (nothing after it). When its `unlocked` flips on one
completion, `isTrackComplete`'s existing `terminalPlainUnlocked ||
lanePrizeUnlocked` rule marks the track done — correct: the prize is earned.
The other 7 tutorials stay visible and openable (optional). No client gating
change needed beyond consuming the server `unlocked` flag it already reads.
Progress ring: confirm it reads "complete" off the earned prize, not 1/8 — if
it shows 12% next to an earned prize that's the §7 `progressPercent` mismatch
to reconcile (treat track as 100% when the authored rule is met, per
`2026-10-22` §7 item 4).

## 4. Rendering fix — fork connector alignment

Second screenshot (the working fork track): the vertical connector lines
between the backbone, the two lane columns, and the join checkpoint **do not
line up** — the lane bubbles' connector stubs and the fork/join connectors are
visually offset. Scope: CSS-only, in `AppSpace.vue` (`.fork-connector`,
`.join-connector`, lane bubble/`.timeline-line` offsets). Behavior unchanged;
`AppSpace.segments.test.ts` fork-render assertions must still pass. This is
cosmetic and independent of §3 — separate commit, same PR.

## 4a. PREREQUISITE — resolver must emit `prizeId` on a standalone checkpoint

**Verified against `path-item-task-resolver.js` (DEV):** `prizeId` is emitted in
exactly ONE place — the synthetic fork-lane checkpoint (`buildPathSegments`
lines 404-419, inside the `fork` branch, when `item.prize_ID` is set). A
**standalone** CHECKPOINT-with-prize path-item (how event `10000015`'s prize is
authored: a plain CHECKPOINT row at its own `itemOrder` carrying a `prize`
association) goes through the **`linear` single-item branch** (lines 363-376),
which calls `shapeItem(task, effLegacyId, record, item.taskType,
item.checkpointTitle, event)` — and `shapeItem` **never reads `prize_ID`**, so
the emitted item carries **no prize marker at all**.

Therefore the §3 detection ("checkpoint carrying a prize") has nothing to match
today. **This is a prerequisite code change, not a field-name footnote:** the
resolver's linear branch (and `shapeItem` or its call site) must thread
`prize_ID` → emit `prizeId` on the standalone CHECKPOINT output item, BEFORE or
WITH the `annotateUnlocked` change. Without it the any-of unlock silently never
fires. (Bonus: once emitted, the client's existing `isTrackComplete`
`lanePrizeUnlocked = checkpoints.some(c => c.prizeId != null && unlocked)` branch
already treats it as track-complete — confirming §3's "no client gating change",
but only *because* this emit lands.)

## 4b. "Immediately preceding" means nearest prior segment, not strict `i-1`

The any-of rule fires only when the prize checkpoint's **nearest preceding
segment is a `parallel-any` cluster with nothing but that cluster between them**
(i.e. `segments[i-1].kind === 'parallel-any'`). If an author places a `linear`
WORK segment (a required tutorial) between the cluster and the prize, the any-of
rule does **not** apply — the intervening segment gates normally (all-of), which
is exactly §2's anti-goal ("cluster then more required work stays all-of"). So
the predicate is strict array-adjacency on the sorted segments: previous segment
is `parallel-any`. A prize checkpoint not directly preceded by a `parallel-any`
keeps today's `prevSatisfied` behavior unchanged.

## 5. What's left to the builder

1. **CSS specifics** of the connector misalignment — measure against the
   screenshot; pick the minimal rule change that aligns backbone↔lane↔join.
   No pixel-level test exists; budget a manual visual-verify loop on DEV.
   Separate commit, same PR (owner's call).
2. **Progress ring reconciliation IS in scope for this PR** (owner's call):
   `progressPercent` must report complete (100%) when the authored rule is met —
   i.e. when `isTrackComplete` is true — so an earned any-of prize doesn't sit
   beside a "1 of 8 / 12%" ring. Regression-test linear + fork per-lane tracks
   so the ring is unchanged for them.
3. **Test matrix** (TDD, author tests first):
   - NEW: `parallel-any` cluster (2 members) + downstream prize checkpoint →
     checkpoint `unlocked` when **one** member COMPLETED; locked when none.
   - NEW (negative): same cluster but followed by a *plain* checkpoint or a
     *further tutorial* segment → stays all-of (one-complete does NOT unlock).
   - REGRESSION (anti-goal guard): the two-lane fork → join checkpoint
     (reproducing screenshot 2) is byte-for-byte unchanged — join locked with
     one lane done, unlocked only with both.
   - #2866 / #2864: an OOW or temporarily-unavailable member does **not** count
     toward the any-of unlock.
   - Client: cluster + earned prize → `isTrackComplete` true, other members
     still openable.

## 6. Constraints / notes

- No `db/schema.cds` change. Pure read-time derivation from `itemOrder`,
  `taskType`, `prize`.
- PR to `DEV`; no direct merge to `main`. Verify on live DEV event `10000015`
  (republishing/rebinding as needed — DEV is the only live tier).
- **"N of M" deferred, not designed here.** If a future event needs "complete 2
  of 8", that needs an explicit count (a new field or convention) — flagged so
  this any-of rule doesn't get silently stretched into it.
