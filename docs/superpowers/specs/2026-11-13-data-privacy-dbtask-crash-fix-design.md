# Design: fix @cap-js/data-privacy DB-task build crash (upstream PR)

**Date:** 2026-11-13
**Author:** (tutorials-ims team)
**Target:** upstream `cap-js/data-privacy` (fork → PR to `main`)
**Relates to:** our eval doc `docs/developers/reference/data-privacy-v070-eval.md`; existing upstream bug (team already filed).
**Size:** small change.

## Intent / why

`cds build --production` crashes in `@cap-js/data-privacy` v0.7.0 with
`TypeError: Cannot read properties of undefined (reading 'elements')` at
`lib/csn-enhancements/retention/exposeEntity.js:26`. This blocks our adoption (issue #977) and any
consumer whose build invokes model loading on a CSN that does not include the plugin's own
`sap.ilm.*` aspect model. Fixing it upstream unblocks us cleanly (no long-lived local patch) and
helps other adopters.

## Root cause

- `cds-plugin.js` registers `cds.on("loaded", (csn) => enhanceModel(csn))` — runs on **every** model
  load, including isolated per-task DB builds.
- `enhanceModel` (`lib/csn-enhancements/index.js:22`) builds `inferredCSN` from the loaded model and,
  for each personal-data entity, calls `exposeRetentionEntity` → `addBlockingAspectToBaseEntity`.
- `addBlockingAspectToBaseEntity` (`exposeEntity.js:26`) does
  `Object.assign(entity.elements, m.definitions["sap.ilm.blocking"].elements)`.
- The `sap.ilm.blocking` / `sap.ilm.destruction` aspects are defined in the plugin's `db/dpi.cds`
  (namespace `sap.ilm`), surfaced via `index.cds`. During a DB-task build CSN, that model is **not**
  present, so `m.definitions["sap.ilm.blocking"]` is `undefined` → `.elements` throws.

Confirmed by reading the source and reproduced with a clean `cds build --production` (see eval doc).

## Goals

- `cds build --production` (and any load-time enhancement) no longer crashes when the plugin's aspect
  model is absent from the CSN being enhanced.
- Blocking/destruction aspect injection continues to work correctly when the plugin's model IS loaded
  (no behavior change for the normal runtime/service CSN).

## Non-goals

- **Blocker 2** (aggregate/GROUP-BY views dropping the data-subject FK). Separate issue; not touched
  here.
- Changing when `cds.on("loaded")` fires, or restructuring the enhancer pipeline.
- Any change to our own repo's model or adoption (this design is the upstream fix only).

## Anti-goals

- A bare use-site `if (!m.definitions["sap.ilm.blocking"]) return;` that silently skips injection.
  That papers over the crash and could leave aspects un-injected in a CSN where they *should* have
  been present — masking real problems. (Rejected approach A.)

## Approaches considered

- **A — minimal use-site guard.** Early-return in `addBlockingAspectToBaseEntity` when the aspect
  def is absent. Smallest diff, but hides legitimately-missing-model cases. Rejected as the primary
  fix (kept only as a defensive assertion with a clear log, see below).
- **B — skip the retention pass when the aspect model isn't loaded.** Correct-ish, small, but leaves
  the plugin unable to enhance a CSN that legitimately needs it but happens not to have pre-loaded
  the aspects.
- **C — ensure the aspect model is present before enhancing (CHOSEN).** Make `enhanceModel`
  guarantee `sap.ilm.blocking` / `sap.ilm.destruction` (and the supporting `sap.ilm` types the
  exposure relies on) exist in the CSN before the exposure loop runs. Fixes the root cause: the
  enhancer no longer depends on load order putting the plugin model into every CSN. Largest of the
  three, but still small and the one maintainers are most likely to accept because it removes the
  hidden ordering assumption rather than working around it.

**Chosen: C**, with A as a defensive backstop (guard + explicit warning log rather than a raw
TypeError) so a future regression fails loudly, not silently.

## The fix (what the builder implements)

In `lib/csn-enhancements/index.js`, before the per-entity exposure loop (around line 42), ensure the
plugin's ILM aspect definitions exist in `inferredCSN.definitions`:

1. If `inferredCSN.definitions["sap.ilm.blocking"]` and `["sap.ilm.destruction"]` are already present
   (normal case), do nothing.
2. If absent, load the plugin's own aspect model and merge those definitions into `inferredCSN`.
   The definitions live in the package's `db/dpi.cds`. Load via `cds.compile`/`cds.load` of the
   plugin-relative path (resolve against the plugin dir, e.g. `require.resolve` of the package then
   its `db/dpi.cds`, or `cds.resolve`), compile to CSN, and copy only the `sap.ilm.*` aspect/type
   definitions the retention exposure needs (`blocking`, `destruction`, and the types referenced by
   `defineILMRootColumns` / value-list enhancement). Guard the load so it runs at most once per
   enhance call and does not pull the plugin's *services* into a DB-task CSN (we only need the
   aspects/types, not `sap.ilm.RetentionService`).

Then in `exposeEntity.js:addBlockingAspectToBaseEntity`, add a defensive guard: if
`m.definitions["sap.ilm.blocking"]` is still undefined, log a clear warning via the plugin LOG and
return without throwing (backstop A).

### Open implementation detail (builder's call, will confirm against source)

Exactly which `sap.ilm.*` definitions to copy: at minimum `blocking` + `destruction`; the exposure
path also references `sap.ilm.Condition` / `sap.ilm.ReferenceDate` / `SelectionCriteria` via
`TableHeaderBlocking.cds`, but those are service-model concerns and likely NOT needed for the DB-task
aspect injection. Builder verifies by tracing which `m.definitions[...]` reads occur on the
`!def.query && !def.projection` base-entity path during a DB-task build, and copies exactly that set.
Prefer the narrowest set that makes the build pass + tests green.

## Verification

- **Regression test** in the plugin's test suite: a fixture model with a `DataSubjectDetails` entity
  and NO explicit load of the plugin's index model, run through `enhanceModel` / a production build,
  asserting it does not throw and that `dppBlockingDate` / destruction fields are injected on the
  base entity.
- **Repro gone:** `cds build --production` on our model with the plugin installed completes without
  the `exposeEntity.js:26` crash.
- Existing plugin tests stay green (no behavior change when the model is loaded normally).

## What's left to the builder

- Fork `cap-js/data-privacy`, branch, implement C + backstop A, add the regression test, run the
  existing suite, open a PR to `main` referencing the existing bug and our repro.
- Confirm the exact minimal set of `sap.ilm.*` definitions to inject (above).
- Match the repo's lint/test/commit conventions.
