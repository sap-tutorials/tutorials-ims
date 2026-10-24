# App Space — Parallel paths within a track (fork lanes & free-order clusters)

**Status:** Design — approved in brainstorming, pending plan
**Date:** 2026-10-22
**Author:** Tom (DevRel) + Claude
**Target branch:** `DEV` (new feature — per project convention, not `main`)
**Related:** #172 (branching paths, partial — alt-group fields), #2866 (completion window), the App Space subsystem (`hugo-apps/src/app-space/`)

---

## 1. Intent & the why

The App Space tool (`/app-space/?eventid=…`, `hugo-apps/src/app-space/AppSpace.vue`) is how event attendees (SAP TechEd, Sapphire, Dev Garage) pick a **track**, work through its tutorials, and earn a prize. Today every track is a **single linear chain**: tutorial → tutorial → checkpoint → prize, each step unlocking strictly when the previous one is `COMPLETED`.

Two real tracks for **2026 SAP TechEd Berlin** don't fit a straight line:

1. **A forking track** ("Explore Agentic AI with CAP"): one shared setup tutorial, then the path **splits into two independent branches** — an *MCP* branch (a chain of tutorials) and an *Agents* branch (another chain). The attendee can pursue both. This is the diagram Tom brought to the design.
2. **A free-order track**: a setup tutorial followed by **6–7 tutorials offered in parallel**, completable in **any order**, no sequence between them.

Neither is expressible today, so these tracks either get mis-modeled as arbitrary linear sequences (forcing a false order) or can't be offered. The why: give event attendees genuine choice of route through a track, and let authors model "do both branches" or "pick your own order" without inventing a parallel concept per event.

**The guiding principle Tom set:** reuse concepts that already exist in the data model — the **`itemOrder` field** and the **GROUP path-item + Group entity** — rather than introduce new schema. Parallelism should *fall out of* how an admin already authors path items.

## 2. The authoring model (decided)

Everything keys off two things an author already sets on a `CompletionPathItems` row: its **Order** (`itemOrder`) and its **type** (`taskType`).

**Rule: path items that share the same `itemOrder` within a path are parallel.** What that parallelism looks like depends on their type:

| Shape | How the author models it | Renders as |
|---|---|---|
| **Linear step** | One path-item at a unique Order | A single timeline node (today's behavior) |
| **Parallel-any cluster** | N **TUTORIAL** path-items sharing one Order | An unordered cluster — all unlock at once, any order |
| **Fork / branch** | 2+ **GROUP** path-items sharing one Order | Side-by-side lanes; each GROUP expands **in place** as its own ordered chain |

Segments run in **Order sequence**: all items at Order *N* must satisfy their completion rule before Order *N+1* unlocks. A single GROUP alone at an Order keeps today's behavior (expands inline as a linear run of its tutorials). The *new* behavior is triggered only when **2+ items share an Order**.

### Worked examples

**Forking track** (Order values illustrative):
- Order 10 — TUTORIAL "Set up CAP Node.js dev env" (shared root)
- Order 20 — GROUP "MCP" **and** GROUP "Agents" (two GROUP rows, both Order 20) → two parallel lanes. Each GROUP row *may* also carry a Prize (see §3) to reward its lane on its own.
- Order 30 — CHECKPOINT "Agentic AI T-shirt" (after the fork; carries the `prize` association) → needs both lanes

**Free-order track:**
- Order 10 — TUTORIAL "Set up CAP dev space" (must be first)
- Order 20 — 6× TUTORIAL rows, all Order 20 → cluster, any order
- Order 30 — CHECKPOINT "Sampler badge" (carries the `prize` association)

> **Terminology note (grounded in the schema).** There is **no `PRIZE` `TaskType`** — the enum is `{ TUTORIAL; GROUP; CHECKPOINT; PUZZLE; PETOBERFEST; KTT_LESSON }` (`db/schema.cds:20`). A track's reward is authored as a **`CHECKPOINT` path-item that carries a `prize` association** (`CompletionPathItems.prize`, schema:476); the App Space barcode/claim UI keys off `type === 'CHECKPOINT'`. The Vue code's `'PRIZE'` type is a **frontend-only display state** the resolver never emits today. Throughout this doc, "prize/checkpoint" means that CHECKPOINT-with-prize path-item.

## 3. Completion rules = prize/checkpoint placement (decided)

**No new completion-config field, and no new schema.** The rule for "what finishes a parallel segment" is expressed by **where the author places the reward** — using fields that already exist on the rows.

**The keystone — GROUP + Prize on the same path-item row (per-lane reward).** `CompletionPathItems` already has **both** `group : Association to Groups` (schema:474) **and** `prize : Association to Prizes` (schema:476) on the same row. When an author sets a GROUP path-item **and** fills in its Prize field, the resolver, after expanding that group's tutorials into a lane, **appends a synthetic CHECKPOINT item carrying that prize at the end of the lane**. Effect: completing **that one branch** earns its reward — the "any one path" rule — *without* needing a checkpoint/prize slot inside `GroupPathItems` (which is tutorial-only: `tutorial @mandatory`, schema:488–490, and is **not** extended by this design).

The synthetic lane-end checkpoint is **derived by the resolver from the path-item's `prize` association**; it is not a separate row the author manages in the Path Items grid. Author's mental model: "GROUP row + Prize on that row = that branch rewards on its own." (Confirmed with Tom: the reward item being implicit is intended.)

**Requirement — the synthetic prize must behave like any normal one (confirmed with Tom).** The resolver must emit the lane-end reward as a **real `CHECKPOINT` output item** (the same shape `shapeItem` already produces: `type: 'CHECKPOINT'`, proper `status`, `imsId`, and a server-computed `unlocked` flag), **not** as a frontend-only `'PRIZE'` display state. This matters because the prize **barcode is already fully decoupled** from authoring: `checkpointBarcodeUrl(eventId)` carries only the event id, the `/api/my-prize-barcode` endpoint reads identity from the **session cookie**, and `shouldShowCheckpointBarcode` fires on `type === 'CHECKPOINT' && unlocked && authenticated` (`checkpoint-barcode.ts:36`) with no dependence on where the checkpoint came from. So a read-time-synthesized CHECKPOINT yields a scannable, claimable barcode identical to a stored one — **provided** it's a true CHECKPOINT in the payload with a correct `unlocked` flag. A plan must not produce a cosmetic-only prize that renders a trophy but no working barcode.

**The join — reward placed *after* the parallel segment (all-paths rule).** A CHECKPOINT path-item at a **higher Order** than the shared fork/cluster Order unlocks only when **all** parallel members at the fork Order are complete.

Both are authorable together: per-lane GROUP+Prize rows at Order 20 **and** a final CHECKPOINT at Order 30 → each branch rewards on its own *and* a final reward needs both. No conflict.

So "complete either branch" vs "complete both" is authored purely by **where the Prize lives** (on the GROUP row vs. on a downstream CHECKPOINT row) — consistent with how linear tracks already work, and nothing new for the admin to learn.

**Parallel-any cluster:** a CHECKPOINT after the cluster requires **all** cluster members complete. (An "N-of-M threshold" — e.g. any 4 of 7 — is explicitly a **non-goal** for this iteration; see §6. All-of is the shipped rule.)

## 4. The rendering (decided — side-by-side lanes)

Chosen over a stacked single-column layout because the fork reads most clearly as literal parallel columns (matches Tom's source diagram). In the **track detail view** of `AppSpace.vue`:

- A **linear** segment renders as today: one bubble + card, vertical connector line down to the next.
- A **fork** segment renders as a **fork connector** (the backbone splits) into **2+ side-by-side lanes**. Each lane is a labeled column; **the label is the Group's own `title`** (e.g. "MCP", "Agents") read from the `Groups` entity — *not* the #172 `altGroupLabel` (see §5/§7: this design ignores the alt-group fields entirely). Each lane contains that group's tutorials as a mini vertical chain, ending in the synthetic prize item if the GROUP row carried one. If a downstream (post-fork) item exists, the lanes **rejoin** with a join connector into that item.
- A **parallel-any** segment renders as an **unordered cluster** (grid of cards), all bubbles in the "available" state at once (subject to the setup gate above them), with a heading like "Pick any — complete in any order."
- **Mobile / 3+ lanes:** lanes are a responsive grid that collapses to stacked labeled blocks on narrow viewports. (Tom approved the 2-lane desktop layout; graceful collapse is a builder responsibility, not a separate decision.)

The mockup Tom approved lives at `.superpowers/brainstorm/*/content/fork-layout.html` for reference (gitignored).

## 5. What this touches (the hard part — grounded in the current code)

**Hard constraint (Tom): NO schema change.** Every field this feature needs already exists in `db/schema.cds` — the change is entirely in *behavior* (resolver, gating, Vue) that re-interprets data the schema already stores. Audit:

| Feature need | Existing field — unchanged |
|---|---|
| Parallel grouping key | `CompletionPathItems.itemOrder` (schema:477) — shared Order = parallel |
| Branch lane | `CompletionPathItems.taskType = GROUP` + `group` assoc (472, 474) |
| Lane contents (ordered chain) | `GroupPathItems` (group→tutorial, ordered) (488–491) — **not extended** |
| Per-lane reward | `CompletionPathItems.prize` assoc **on the same GROUP row** (476) |
| Join reward | `CompletionPathItems.taskType = CHECKPOINT` + `prize`, higher Order |
| Free-order cluster | N `TUTORIAL` rows sharing one `itemOrder` |

No new entities, columns, or `TaskType` enum values; `GroupPathItems` is untouched; the #172 `altGroupKey`/`altGroupLabel` fields are **ignored**, not extended. The synthetic lane-end checkpoint and the segment structure are **derived at read time** in the resolver — stored rows stay pure existing-schema. This is the mechanism that keeps the feature schema-free.

This is **not** a CSS-only change, though: the current pipeline actively destroys the structure the UI needs:

- **`srv/lib/path-item-task-resolver.js` → `buildPathItems()`** flattens every path into a **flat, order-less array**. GROUP items are expanded inline into their child tutorials and spliced into that flat list; `itemOrder` and group identity are **discarded** in the output. The payload (`AppSpaceTrack.items: AppSpaceItem[]`) has no notion of "these share an Order" or "these belong to the MCP lane." It also **never reads the Group's `title`** (only `GroupPathItems` → tutorials via `expandGroupTutorials`), so sourcing the lane label from the Group title is a **new read/join** to plan.
- **`hugo-apps/src/app-space/app-space-gating.ts` → `isItemUnlocked()`** gates strictly on the **immediately preceding array index** (`items[index-1].status === 'COMPLETED'`). No concept of Order groups or branch completion.
- **`AppSpace.vue`** renders one flat vertical `v-for` over `selectedTrack.items`, and computes `isTrackComplete`/`progressPercent`/`completedCount`/barcode-eligibility over that **flat** list (lines 234–243, 299–309).

So the design requires, in order:

1. **Payload shape change** — the track payload carries **segments** (ordered groups keyed by `itemOrder`), each tagged `kind: 'linear' | 'parallel-any' | 'fork'` and carrying its `order`; fork segments carry **named lanes** (label = Group `title`), each with its own ordered items (including a synthetic trailing CHECKPOINT when the GROUP row had a `prize`). A single-item Order stays a `linear` segment so linear tracks are byte-for-byte unchanged. Keep a flattened `items[]` alongside segments if cheaper for back-compat, or migrate the Vue fully to segments — builder's call (§7.2).
2. **Server builder change** — group path items by `itemOrder` **before** deciding flatten-vs-nest (the detection "2+ members at this Order" must precede the per-item loop that today flattens unconditionally). For a GROUP member, nest the expanded `GroupPathItems` chain under a lane; if that path-item has a `prize`, append a synthetic CHECKPOINT (carrying the prize) to the lane. A **lone** GROUP at an Order keeps today's inline-flatten behavior. Reuse `expandGroupTutorials`; add a batched read of `Groups.title` for lane labels.
3. **Gating engine change — server-authoritative.** Move unlock computation **server-side**: emit a per-item/`unlocked` (or per-lane/segment completion) flag in the payload, so the client stops index-walking. Rationale (builder call, §7.4): a cluster/fork has no "previous array index"; the server already owns `status` including the #2866 `COMPLETED_OUT_OF_WINDOW` downgrade (`effectiveStatus`) **and** must compose with the #2864 `temporarilyUnavailable` flag (schema:483) — keeping the gate next to that state avoids re-deriving two downgrade rules on the client. `app-space-gating.ts` becomes a thin reader of the server flag (keep its pure signature for tests). Rule: an Order-group unlocks when the previous Order-group meets its completion rule; a post-fork item unlocks only when **all** lanes complete; a GROUP-row's synthetic prize unlocks on **that lane** alone.
4. **Vue rendering change** — render segments: linear nodes, fork lanes (side-by-side, fork/join connectors), parallel-any clusters. **Recompute track-level aggregates against the authored completion rule, not the flat list:** when a fork uses per-lane rewards ("either branch"), `isTrackComplete`/progress/barcode must treat the track as complete when the authored rule is met (e.g. one lane + its prize), *not* when every tutorial is done — otherwise the progress ring contradicts a prize the user just earned. Preserve status styles, Joule/Sapphire theming, confetti, checkpoint barcode, redo (#2866) and temporarily-unavailable (#2864) states.
5. **Admin UI** — confirm the Path Items editor allows **duplicate Order values** and setting `group` + `prize` on one row (the screenshot shows Order, a GROUP type, and a Prize field already exist). If the editor blocks duplicate Orders or makes GROUP+Prize authoring awkward, that's in scope. *(Builder: verify against `app/admin/*` completion-path components — §7.3.)*

## 6. Goals / non-goals / anti-goals

**Goals**
- Model the **entire** feature within the existing schema — zero new entities/columns/enum values (hard constraint from Tom).
- Author parallel segments using only `itemOrder` + GROUP path-items + the existing `prize` association.
- Render forks as side-by-side lanes and free-order sets as any-order clusters inside one track.
- Completion rule ("either branch" vs "both branches") expressed by **where the Prize lives** (GROUP row vs. downstream CHECKPOINT row).
- Linear tracks render and gate **exactly** as they do today (zero regression).

**Non-goals (this iteration)**
- **N-of-M thresholds** for clusters ("any 4 of 7"). Ship all-of; shape the segment model so a threshold could be added later without reshaping the payload.
- Nested forks (a lane that itself forks). Groups expand one level deep, as today.
- Cross-track dependencies / conditions (the #172 `altCondition` DSL). Out of scope.
- Changing the track-selection grid ("Choose Your Track") — only the **detail** view changes.
- Any change to `db/schema.cds`, `GroupPathItems`, or the `TaskType` enum.

**Anti-goals (would make this a failure even if it "works")**
- Any regression to existing linear TechEd/Sapphire tracks, to #2866 window gating, or to #2864 temporarily-unavailable handling.
- Reviving or extending #172's half-built `altGroupKey`/`altGroupLabel` mechanism — this design **ignores** those fields and groups purely on `itemOrder`. Do not make authoring depend on altGroupKey, and do not alter the shared `groupByAlt`/alt-group validator for this feature.
- Making authors learn a new completion-config UI when Prize placement already expresses intent.

## 7. Open calls left to the builder

The builder-check resolved the data-model questions (folded into §3/§5 as decisions: CHECKPOINT-with-prize is the reward; grouping is pure-`itemOrder`; alt-group fields ignored; lane labels from Group `title`; gating moves server-side; track aggregates follow the authored rule). What remains genuinely open:

1. **Exact payload schema** for segments/lanes (TypeScript interfaces in `AppSpace.vue` + the server shape). Sensible default: `AppSpaceTrack.segments: Array<LinearSegment | ClusterSegment | ForkSegment>`, each tagged by `kind` and carrying `order`; decide whether to keep a parallel flat `items[]` for back-compat or migrate the Vue fully to segments.
2. **Admin editor ergonomics** — verify the Path Items editor allows duplicate Order values and GROUP+Prize on one row; extend only if it blocks them.
3. **Test strategy** — unit tests for the server segment builder and the (now server-side) gating rule (in-memory SQLite, `npm test`), including a lone-GROUP-stays-linear regression and a `temporarilyUnavailable`-member-in-a-fork case; plus a committed e2e spec for the detail view (advisory per CLAUDE.md for `app/**`/`hugo/**`).

## 8. Constraints

- CAP Node.js backend; HANA in prod, in-memory SQLite for unit tests. Never SELECT a HANA BLOB alongside metadata (not relevant here — these are metadata reads).
- Frontend is a Vue 3 island built into `hugo/static/js/` — not a route. Island manifest/build caveats from CLAUDE.md apply at deploy time.
- Feature should be shippable behind the existing event/mission plumbing; no new env var (DB-driven config is the house style, but here no config is even needed — placement drives behavior).
- PR to `DEV`; no direct merge to `main`.
