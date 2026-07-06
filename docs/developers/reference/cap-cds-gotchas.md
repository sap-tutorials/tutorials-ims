# CAP / CDS gotchas

A reference of CAP- and CDS-specific pitfalls that have bitten this project. Each section is a single discovered failure mode with cause, why, and how to apply. These were originally one-fact agent-memory files; consolidated here so platform engineers find them via the VitePress sidebar instead of by guessing memory names.

> Originally maintained as separate memory entries under `~/.claude/projects/d--projects-tutorials-poc/memory/`. Promoted to docs 2026-06-24 to make them discoverable to humans + agents alike.

## How to use this doc

Search (Ctrl-F) for the error message you're seeing, the API you're using, or the symptom. Each section is independent — read only the one you need.

## Sections

- [req.user is not public API on CAP — use cds.context.user](#req-user-is-not-public-api-on-cap-use-cds-context-user)
- [CAP silently drops annotations on projection-FK columns](#cap-silently-drops-annotations-on-projection-fk-columns)
- [Draft-enabled $top requires IsActiveEntity filter](#draft-enabled-top-requires-isactiveentity-filter)
- [Draft composition before-hook writes get wiped by activation](#draft-composition-before-hook-writes-get-wiped-by-activation)
- [Default-OFF feature flags need a live smoke before merge](#default-off-feature-flags-need-a-live-smoke-before-merge)
- [cds.load does not auto-discover sibling .cds files](#cds-load-does-not-auto-discover-sibling-cds-files)
- [cds.entities() is runtime-only — undefined in plain CJS scripts](#cds-entities-is-runtime-only-undefined-in-plain-cjs-scripts)
- [CDS CSN: flat dotted keys vs nested annotation objects](#cds-csn-flat-dotted-keys-vs-nested-annotation-objects)
- [CAP CSV seeds clobber admin-edited data on every deploy](#cap-csv-seeds-clobber-admin-edited-data-on-every-deploy)
- [Explicit FK conflicts with Association — key the association directly](#explicit-fk-conflicts-with-association-key-the-association-directly)
- [package.json "type":"module" forces srv/lib/* to ESM exports](#package-json-type-module-forces-srv-lib-to-esm-exports)
- [LargeBinary @Core.MediaType is excluded from SELECT.* and returns a stream](#largebinary-core-mediatype-is-excluded-from-select-and-returns-a-stream)
- [@PersonalData EntitySemantics — DataSubject vs DataSubjectDetails vs Other](#personaldata-entitysemantics-datasubject-vs-datasubjectdetails-vs-other)
- [Anonymization handler uses a hardcoded entity allowlist](#anonymization-handler-uses-a-hardcoded-entity-allowlist)
- [audit-logging crashes worker on EntitySemantics:Other + field-level @PersonalData](#audit-logging-crashes-worker-on-entitysemantics-other-field-level-personaldata)
- [OData bound action binding mode: collection vs instance](#odata-bound-action-binding-mode-collection-vs-instance)
- [check-cds-build-staging fails on csn.json diff after annotation changes](#check-cds-build-staging-fails-on-csn-json-diff-after-annotation-changes)
- [Commit cds build artifacts alongside schema.cds changes](#commit-cds-build-artifacts-alongside-schema-cds-changes)
- [Module singletons load twice under vitest + cds.test on Windows](#module-singletons-load-twice-under-vitest-cds-test-on-windows)
- [@assert.unique on nullable columns + why khorosLogin isn't unique](#assert-unique-on-nullable-columns-why-khoroslogin-isnt-unique)
- [`cds.outbox.Messages` is framework-owned — bind via `cds.entities`, never hardcode column names](#cdsoutboxmessages-is-framework-owned--bind-via-cdsentities-never-hardcode-column-names)

---

## req.user is not public API on CAP — use cds.context.user

CAP's XSUAA `jwt-auth` middleware (DEV/PROD) sets ONLY `cds.context.user`. The mocked `basic-auth` middleware used by `cds watch` and unit tests sets BOTH `cds.context.user` AND `req.user`. So `req.user` works locally and silently 401's on every real XSUAA deploy.

The [CAP June 2024 release note](https://cap.cloud.sap/docs/releases/2024/jun24) explicitly says:
> do not use `express.Request.user/tenant` as they are internal to authentication strategies and not public API.

**Why:** This bit us on `/api/codecheck` and `/api/validate-answer` (both AI grader handlers) — bug #581. Readers got "Sign in to check your code" while signed in. The smoke test only checked the unauth path so it couldn't tell apart "401 because anonymous" from "401 because handler ignored auth."

**How to apply:**
- In every express handler that wraps a CAP route, read `cds.context?.user`, not `req.user`.
- For unit-test compat, fall back: `const user = cds.context?.user || req.user;`.
- Unit-test the XSUAA shape explicitly: set `cds.context = { user: new cds.User({ id }) }` with `req.user` ABSENT, expect 200.
- The other handlers in this repo (`/auth/user`, `/chat/stream`, embeddings-stats, exports bridge) already follow this rule — copy their shape.

Related: [Default-OFF feature flags need a live smoke before merge](#default-off-feature-flags-need-a-live-smoke-before-merge) — same class of "green on CI, broken on real deploy" gap.

---

## CAP silently drops annotations on projection-FK columns

When you write `entity X as projection on ims.X` where `ims.X` has `tag : Association to Tags`, the CDS compiler synthesizes a `tag_ID` foreign-key column on the projection. **You cannot annotate this synthesized FK directly** — `annotate AdminService.X with { tag_ID @Common.Text: tag.label };` is **silently dropped** by the compiler.

It surfaces as a build warning:

```
[WARNING] app/admin-annotations.cds:1711:3-9: Element "tag_ID" has not been found
          (in annotate:"AdminService.X"/element:"tag_ID")
```

…and the resulting csn.json has no `elements.tag_ID` entry. The OData `$metadata` likewise lacks the annotation. FE V4 then has no `@Common.Text` to follow on the FK column and renders the raw GUID in the LineItem cell.

**Caught 2026-06-24 (PR #588).** PR #586 attempted this on `AdvocateTopics` to fix the GUID-in-Topics-column bug. The annotation was dropped silently; the table kept rendering GUIDs.

**How to apply:** Bind the `@UI.LineItem` `Value` directly to the navigation path:

```cds
annotate AdminService.AdvocateTopics with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: tag.label, Label: 'Topic' }
  ]
};
```

FE V4 renders navigation values natively. Editing still works because the `@Common.ValueList` on the `tag` association attaches a value-help dialog whose `ValueListParameterInOut` writes back to `tag_ID`.

**Don't be fooled by "GroupTags and MissionTags do it with tag_ID and they work"** — they DON'T. They have the same `Value: tag_ID, Label: ...` shape with annotations on `tag` only, and very probably render GUIDs too. Nobody had noticed because the GroupTags / MissionTags inline tables are rarely viewed in admin UI.

Related: `feedback_my_optimism_was_wrong_again_2026_06_20.md`, [CDS CSN: flat dotted keys vs nested annotation objects](#cds-csn-flat-dotted-keys-vs-nested-annotation-objects), `feedback_audit_all_callers_of_buggy_primitive.md`.

---

## Draft-enabled $top requires IsActiveEntity filter

When an entity has `@odata.draft.enabled` in the CDS service, CAP rejects `$top` queries on its collection with:

```
System query option $top is not supported
```

…unless the query also includes `$filter=IsActiveEntity eq true` (or `eq false`). The reason: CAP needs to know which "layer" (active vs draft) to page over. Without the filter, paging is ambiguous.

UI5 V4 list bindings (ComboBox, Table, etc.) **always append `$top`**, so any binding to a draft-enabled collection without an `IsActiveEntity` filter fails on load with "$top is not supported".

**Caught 2026-06-24 (PR #588).** The Devtoberfest admin tile bound a ComboBox to `/Events` (draft-enabled in app/admin-annotations.cds line 7), no filter. The entire tab failed to render.

**How to apply:** When you bind to a draft-enabled collection in XML/JS, ALWAYS add the filter:

```xml
<ComboBox items="{
  path: '/Events',
  parameters: {
    '$orderby': 'startDate desc',
    '$filter': 'IsActiveEntity eq true'
  }
}" />
```

If you need both active + draft entries (rare for admin lists; common for object-page nav), use `$filter=IsActiveEntity eq true or HasDraftEntity eq true` to fetch active + un-published drafts.

Related: [Draft composition before-hook writes get wiped by activation](#draft-composition-before-hook-writes-get-wiped-by-activation), `feedback_ui5_dollar_vs_percent_binding.md`.

---

## Draft composition before-hook writes get wiped by activation

When wiring a hook that writes child rows to a Composition of a draft-enabled parent (e.g. `Groups` with `slugRedirects : Composition of many GroupSlugRedirects`), a `before('UPDATE')` or `before('SAVE')` insert into the child entity from inside the parent-write hook **gets wiped** by CDS draft activation. The activation flow rebuilds composition children from the draft side, replacing whatever rows the active table held — so any insert your hook just made is gone.

**Why:** CAP draft activation: `draftActivate` reads the draft (and its drafted compositions), then on the active entity it DELETEs all composition children and re-INSERTs them from the draft's children. Your before-hook ran during that activation; its INSERT into the active child table is replaced as part of the cascade.

**How to apply:** When you need a hook to maintain side-table data adjacent to a draft-enabled entity:
- **Default:** make the side table a standalone entity with a plain `Association` to the parent, NOT a `Composition`. Activation no longer touches it.
- **If composition is required** (cascade-delete on parent removal is desirable), write into the *draft's* composition children before activation, OR move the write to an `after('UPDATE'|'CREATE')` hook so it lands after the activation cascade.

**How we found it:** PR for #91 follow-up (Groups/Missions slug-history). First attempt modeled `slugRedirects` as a Composition; the before-hook insert succeeded inside its own SELECT but the test's SELECT after activation showed an empty table. Switching to plain Association resolved it. Symptoms (handler insert visible synchronously inside hook, gone after request completes) are easy to misdiagnose as transaction rollback or vitest module-singleton issues.

---

## Default-OFF feature flags need a live smoke before merge

When a feature ships behind a `ChatSettings.codeCheckEnabled = false` (or similar default-OFF master flag), unit tests are not enough — the substrate can be silently broken in production for weeks until someone tries to use it.

**Why:** Unit tests typically exercise the handler in isolation (mock req/res, no `cds.serve`). They cannot catch:
- Route shadowing by CAP's OData router when express handlers are mounted in `served` instead of `bootstrap`
- Module-init failures that only surface when the runtime fully boots
- Auth middleware misconfiguration
- Anything that requires the full express + middleware + handler chain

**How to apply:** For any PR that adds/changes a default-OFF endpoint:

1. Add a `cds.test('serve')` unit test that boots CAP and probes the route. ~4 seconds runtime, catches the most common route-shadowing failure shape. See [test/unit/server-route-mounting.test.js](test/unit/server-route-mounting.test.js) for the pattern: 2 negative assertions (response body NOT containing OData parser error) + 1 positive control (sibling OData route still serves metadata).

2. Document a live-deploy smoke validation history in the script/handler source. Counter-pattern: PR #287 [scripts/preflight-ai-quiz-smoke.ts:15](scripts/preflight-ai-quiz-smoke.ts#L15) records "Validation history: 2026-06-08: initial 5-slug end-to-end run on seed 99". PR #205 had no equivalent for `/api/codecheck` and shipped broken.

3. The smoke can be the existing test/smoke/*.test.js files — but they have to actually run in CI (currently broken since April 2026 per the deploy.yml workflow status). Adding one negative-shape assertion ("response NOT containing the OData parser error") guards the specific route-shadowing failure.

**The two production bugs this surfaced** (`project_210_phase4_blocked_by_314_315.md`): #314 (route shadowing) and #315 (`cds.entities` not initialized in `cds bind --exec`). Both shipped 2026-06-02 / 2026-06-08 and weren't caught for 11+ days because nothing exercised the deployed code path.

Pattern repeats anywhere flag-gated features ship: branch features off `ChatSettings.branchingEnabled`, AI quizzes off `AI_AUTHOR_ENABLED` (removed on close-out of #312, but the lesson stands), etc.

---

## cds.load does not auto-discover sibling .cds files

**Why:** When a drift-guard test asserts that an entity carries an annotation defined in a *sibling* `.cds` file (e.g. `@PersonalData` on `UserLearningPreferences` lives in `db/audit-logging.cds` while the entity itself is in `db/schema.cds`), `cds.load('db/schema.cds')` returns a CSN with the entity but no annotation — the walker silently returns no entry, the test passes vacuously by `expect(undefined).toBeDefined()` failing in a way that looks like a missing entity.

**How to apply:** In any drift-guard test that loads CSN to verify an annotation, list **every** `.cds` file that contributes annotations OR pass the directory:

```js
// Wrong — annotations in sibling files are missed silently
const csn = await cds.load('db/schema.cds');

// Right — explicit list
const csn = await cds.load(['db/schema.cds', 'db/audit-logging.cds']);

// Or load the whole db/ directory (picks up every .cds under it)
const csn = await cds.load('db');
```

Discovered in PR 6 (issue #172) round-2 plan review — the cascade-walker drift test would have passed vacuously because the entity was loaded but its `@PersonalData` annotation was not. The test asserts `entry?.action === 'delete'`, which `?.` chains nullify so the assertion silently fails to match what the test believes it covers.

**Where it bit us:** `project_172_pr6_pilot_enablement_shipped.md` · the `scripts/__tests__/anonymization-cascade-pr6.test.ts` file. Fix landed at commit `d46c098`.

Related: `feedback_silent_swallow_hides_dead_code.md`

---

## cds.entities() is runtime-only — undefined in plain CJS scripts

In a plain CJS / standalone Node script (the `npx cds bind --exec -- node
script.cjs` shape), `cds.entities()` is undefined even after `await
cds.load('*')`. It is set by the CDS runtime when it boots a server, not
by the model loader. Confirmed via `node -e "const cds=require('@sap/cds');
(async ()=>{ await cds.load('*'); const db=await cds.connect.to('db');
console.log(typeof cds.entities, typeof db.entities); })()"` →
`undefined  object`.

**Why:** Calling `cds.entities()` in `scripts/cleanup-catalog-pollution.cjs`
crashed with `TypeError: cds.entities is not a function` in PR #120.

**How to apply:** In maintenance / one-shot CJS scripts, drive the DB via
**raw SQL on the underscore-flattened HANA table names**, the same pattern
`reference_hana_migration_creds.md` / `setup-dev-data.cjs` use:

```js
await cds.load('*')
const db = await cds.connect.to('db')
const T = (n) => `COM_SAP_DEVELOPERS_IMS_${n.toUpperCase()}`
await db.run(`SELECT * FROM "${T('Tutorials')}" WHERE "SLUG" LIKE ?`, ['group-%'])
```

If you need entities in a script-shape file, `db.entities` (after
`cds.connect.to('db')`) does work and gives you the same handles, but the
raw-SQL pattern is more readable for sweep-and-delete one-shots and
matches the project precedent. Composition cascade does NOT happen with
raw SQL — you must delete dependents explicitly (Steps, TutorialMeta etc.).

---

## CDS CSN: flat dotted keys vs nested annotation objects

A walker that introspects CSN definitions for an annotation like `@PersonalData` cannot rely on the annotation being a nested object. Two shapes exist depending on how the annotation was authored:

- **Inline annotation in the same file** (`entity Foo { @PersonalData: { EntitySemantics: 'Other' } ... }`) → may emit `def['@PersonalData']` as a nested object.
- **`annotate` directive in a separate file** (the standard pattern in `db/audit-logging.cds`) → emits **flat dotted keys**: `def['@PersonalData.EntitySemantics']`, `def['@PersonalData.cascade']`. There is NO `def['@PersonalData']` key.

If your walker checks only the nested form, it will silently no-op on production CSN. Synthetic-mock tests using the nested form will pass; real-CSN deploy tests will fail.

**Caught 2026-06-04 in #211 Task 3 execution.** The Task 2 implementation of `getCascadePlan` checked `def['@PersonalData']` only and would have silently no-op'd on `db/audit-logging.cds`-defined annotations. Fixed by normalizing both shapes:

```js
function getPersonalDataDescriptor(def) {
  if (def['@PersonalData']) return def['@PersonalData'];          // nested form
  // Flat form: collect all '@PersonalData.*' keys into an object
  const flat = {};
  for (const k of Object.keys(def)) {
    if (k.startsWith('@PersonalData.')) flat[k.slice('@PersonalData.'.length)] = def[k];
  }
  return Object.keys(flat).length ? flat : null;
}
```

**How to apply:**
- When writing CDS annotation walkers, ALWAYS test against `cds.deploy()` of real `.cds` files, not just synthetic mocks.
- The flat-key form is the primary production shape; nested-object form is the edge case (inline annotations).
- Co-deploy ALL `.cds` files containing relevant annotations — `cds.deploy('db/schema.cds')` alone misses annotations from `db/audit-logging.cds`.

---

## CAP CSV seeds clobber admin-edited data on every deploy

CAP's HDI deployer treats every CSV in `db/data/` as authoritative seed
data and **re-imports them on every deploy** as an UPSERT keyed on the
primary key column(s). For entities where admins actively edit data,
this means:

> A row whose primary key matches a CSV row gets its non-key columns
> reverted to the CSV values on the next deploy.

There's no "import only if empty" or "import only if not present"
mode. The CSV becomes the source of truth — even if the row was edited
30 seconds before deploy.

**Recognition pattern**: admin reports "I edited X yesterday and now
it's back to the original values" right after a deploy.

**Don't do**: ship placeholder data via CSV for entities that admins
actively edit. Even if the CSV is "just five rows for the demo",
those five rows will be revert-attacked on every deploy.

**Do instead**:

- Ship empty for admin-managed entities. Let admins populate via the
  Fiori UI on first deploy.
- For one-shot dev convenience, use a separate `npm run setup-dev-data`
  script that's run manually (the project already has this pattern for
  slug population — see `scripts/setup-dev-data.cjs`).
- For genuinely fixed taxonomies (where admins should NOT edit, e.g.
  the 8 hard-coded Categories), CSVs are correct.

Discovered 2026-06-17 (Tom): the developer-advocates feature shipped
with `Advocates.csv` + `AdvocateLinks.csv` for the 5 placeholders. Tom
populated real advocates via the admin UI between deploys; the next
deploy reset everything back to placeholders. Fix: PR #397 removed
the CSVs.

**Memory link**: see also `project_developer_advocates_impl.md` for the
broader feature context, and the architecture doc at
`docs/developers/architecture/advocates.md` was updated with the
"no CSV seed" note for future reference.

---

## Explicit FK conflicts with Association — key the association directly

When you want a child entity keyed by its parent (1:1 composition, e.g.
`AdvocatePhotos` keyed by the `Advocate` it belongs to), DO NOT write:

```cds
entity AdvocatePhotos {
  key advocate_ID : UUID;
  advocate        : Association to Advocates not null;
  ...
}
```

CAP errors with:
```
[ERROR] Generated foreign key element "advocate_ID" for association "advocate"
        conflicts with existing element
```

CAP refuses to reconcile an explicit FK column with the FK column it
auto-generates for the association. The `key` modifier on the explicit
column does NOT make CAP "reuse" it.

The correct pattern is to put `key` directly on the association:

```cds
entity AdvocatePhotos {
  key advocate : Association to Advocates not null;
  ...
}
```

CAP generates a single `advocate_ID` column that serves as both PK and FK,
enforcing 1:1 at the schema level. Functionally identical to the intent
above, but actually compiles.

**Why:** Discovered 2026-06-17 during Task 1.2 of the developer-advocates
implementation. The original plan and spec carried the broken form because
neither was tested against `cds deploy` before being approved by the
spec-reviewer or plan-reviewer subagents — neither subagent runs the
schema. Lesson for future spec-reviews: schema-level CDS claims need a
real compile test before being trusted.

**How to apply:** Whenever a new 1:1 child entity needs to be keyed by
its parent, write `key <assoc> : Association to <Parent> not null` and
let CAP generate the FK column. Do not declare a separate `<assoc>_ID`
key. Related: [CDS CSN: flat dotted keys vs nested annotation objects](#cds-csn-flat-dotted-keys-vs-nested-annotation-objects) (another
case of "the docs lie about CSN shape" — verify with a real cds compile).

`project_developer_advocates_shipped.md` (when shipped, link the spec
that originally carried the broken form so future me has the
counter-example).

---

## package.json "type":"module" forces srv/lib/* to ESM exports

When `package.json` has `"type": "module"`, Node's native ESM loader
(used by `cds run`, `npm start`, deployed CAP runtime) treats every
`.js` file as ESM. A `srv/lib/foo.js` written as CommonJS:

```js
'use strict';
function foo() { ... }
module.exports = { foo };
```

CANNOT be imported by another ESM file via:

```js
import { foo } from './lib/foo.js';
// SyntaxError: The requested module './lib/foo.js' does not provide an export named 'foo'
```

**The trap**: Vitest has its own interop layer that synthesizes named
imports from `module.exports`, so unit tests pass green even though
production runtime would fail at boot. You only catch this at `cds run`,
or worse, on the deployed instance.

**Verification**: drop a temp `.mjs` file at the project root with
`import { x } from './srv/lib/y.js'; console.log(x)` and run with
`node ./tmp.mjs`. If the project is `"type":"module"` AND the lib uses
`module.exports`, this fails — but `npx vitest run` against the same
imports passes. That's the smoking gun.

**Fix**: write `srv/lib/*.js` as ESM (`export function ...`) when the
project is `"type":"module"`. CAP scripts under `scripts/*.cjs` (which
exist deliberately as CJS) are unaffected because they have an explicit
`.cjs` extension.

Discovered 2026-06-17 during Task 4.3 of the developer-advocates
implementation. The plan's Task 2.2 and Task 3.3 both shipped CJS-style
`module.exports` lib modules; Vitest hid the problem until Task 4.3
needed to import them from a real handler that gets loaded by `cds run`.
Recovery: convert both modules to ESM (`feat(advocates): convert lib
modules from CJS to ESM`).

**How to apply**:
1. When adding any new `srv/lib/*.js` module to a project where
   `package.json` has `"type": "module"`, write it ESM-native from the
   start. Don't reach for `'use strict'` + `module.exports`.
2. When reviewing a plan that proposes new lib modules, check the
   project's `"type"` field FIRST and prescribe matching exports.
3. When reviewing a plan-output, run a quick `node` smoke from a `.mjs`
   file at the project root that imports the new module — Vitest alone
   isn't enough.

Related: [Explicit FK conflicts with Association — key the association directly](#explicit-fk-conflicts-with-association-key-the-association-directly) (also
caught at Phase 4 — the spec/plan-review loop missed both because
neither runs `cds deploy` or `cds run`).

---

## LargeBinary @Core.MediaType is excluded from SELECT.* and returns a stream

Two surprises when reading a CAP `LargeBinary` column annotated with
`@Core.MediaType`:

1. **Default `SELECT.* from(Entity)` does NOT include the BLOB column.**

   ```js
   const { AdvocatePhotos } = cds.entities('com.sap.developers.ims');
   const photo = await db.run(SELECT.one.from(AdvocatePhotos).where({...}));
   photo.photo256;  // → undefined  ← surprise
   ```

   CAP filters `@Core.MediaType` columns out of default projections because
   it expects you to fetch them via the OData media-stream URL. To read the
   bytes through CDS QL you must list them explicitly:

   ```js
   const photo = await db.run(
     SELECT.one
       .from(AdvocatePhotos)
       .columns('photo256', 'photoMimeType', 'sha256')
       .where({...}),
   );
   photo.photo256;  // → Readable
   ```

2. **The returned column is a `Readable` stream, NOT a `Buffer`.**

   Even on SQLite, CAP wraps `LargeBinary` columns in a Node `Readable` so
   the consumer can pipe to a response. To get bytes you must drain:

   ```js
   async function streamToBuffer(stream) {
     const chunks = [];
     for await (const chunk of stream) chunks.push(chunk);
     return Buffer.concat(chunks);
   }
   const bytes = await streamToBuffer(photo.photo256);
   ```

   `Buffer.from(stream)` and `Buffer.isBuffer(stream)` will NOT work — the
   first throws `TypeError: The first argument must be of type string or
   instance of Buffer...`, the second returns false.

**Why these matter together**: a naïve `SELECT.from(...)` then
`Buffer.isBuffer(row[col]) ? row[col] : Buffer.from(row[col])` fails BOTH
ways — the column is missing entirely, OR (when listed explicitly) it's a
stream that `Buffer.from()` rejects. Both bugs hide in unit tests until
the round-trip path actually runs.

Discovered 2026-06-17 while implementing Task 5.1 of the
developer-advocates feature. Took two iterations to diagnose: first the
column was missing, then once added it was a stream.

Related: [Explicit FK conflicts with Association — key the association directly](#explicit-fk-conflicts-with-association-key-the-association-directly) (also
Phase-4 of advocates) and the broader pattern of CAP runtime behaviors
that don't match what the CSN compile and Vitest interop suggest.

**How to apply**: when reading a `LargeBinary` via CDS QL, always (a)
list the BLOB columns explicitly in `.columns(...)`, and (b) drain the
result through a `streamToBuffer()` helper before treating it as a
Buffer. The HANA path (raw `db.run('SELECT ...')` SQL) returns Buffers
directly, so this drain logic only matters for SQLite/CDS-QL reads — but
the helper should accept both inputs to keep callers simple.

---

## @PersonalData EntitySemantics — DataSubject vs DataSubjectDetails vs Other

For `@PersonalData : { EntitySemantics: '…' }`:

- **`'DataSubject'`** — the entity IS a data-subject identity record. e.g. `Users`. Pair with `DataSubjectRole`.
- **`'DataSubjectDetails'`** — describes a data subject (addresses, profiles, task records). e.g. `UserMetaData`, `TaskRecords`.
- **`'Other'`** — references a subject via FK but is neither (telemetry, submissions, orders). NO `DataSubjectRole` allowed.

Caught 2026-06-02 in code-quality review of `project_admin_analytics_explorer.md` Task 1.1: spec wrote `'DataSubject', DataSubjectRole: 'Learner'` for `CodeCheckSubmissions` (a per-submission telemetry record). Reviewer flagged: that's a telemetry record, not a subject record — should be `'Other'` with no role. Mistake originated in the spec; reviewer's catch saved it from landing in HANA.

Symptom if wrong: SAP Personal Data Manager / audit-log walks the entity graph treating telemetry rows as root subjects → cascade misbehavior.

Verify against `feedback_check_plugin_versions.md` (cds-mcp) when authoring `@PersonalData` annotations on a new entity, especially anything ending in `Submissions`, `Logs`, `Records` that references `Users` via FK.

---

## Anonymization handler uses a hardcoded entity allowlist

**Status: RESOLVED in PR for [#211](https://github.com/sap-tutorials/tutorials-ims/issues/211).** The handler now walks `@PersonalData` annotations automatically via `srv/lib/anonymization-cascade.js`. New entities annotated `@PersonalData` get the default `'null-personal'` cascade with no JS change. The note below is preserved for archive context.

`_executeAnonymization` in [srv/admin-service.js:829](srv/admin-service.js#L829) explicitly walks Users, UserMetaData, and TaskRecords. Adding `@PersonalData` annotations to a NEW entity does not auto-cascade — the anonymization handler has to be extended to include the new entity in its DELETE/UPDATE pass.

**Why:** Found 2026-06-02 during the #171 code-check spike Task 3.1 hybrid-test authoring. Annotated `CodeCheckSubmissions` correctly per [@PersonalData EntitySemantics — DataSubject vs DataSubjectDetails vs Other](#personaldata-entitysemantics-datasubject-vs-datasubjectdetails-vs-other) (`EntitySemantics: 'Other'`, `submittedCode` flagged `IsPotentiallyPersonal`). The hybrid test for the cascade was `it.skip` because the handler doesn't actually do the cascade.

**How to apply:**
- When adding a new `@PersonalData`-annotated entity that should participate in user anonymization, ALSO extend `_executeAnonymization` to UPDATE/DELETE its rows when the user is anonymized.
- The annotation is necessary (drives audit-log + PDM walk) but not sufficient for the cascade to fire.
- For the spike: Admin gating is the compensating control; cascade extension is a follow-up issue.

---

## audit-logging crashes worker on EntitySemantics:Other + field-level @PersonalData

`@cap-js/audit-logging` v1.x crashes the worker process on any CRUD INSERT/UPDATE/DELETE if an entity is annotated with `EntitySemantics: 'Other'` AND has field-level `@PersonalData.IsPotentiallyPersonal` or `@PersonalData.IsPotentiallySensitive`. The plugin's `addDataSubjectForDetailsEntity()` walks the template looking for a parent DataSubject, finds `undefined`, throws:

```
TypeError: Cannot read properties of undefined (reading 'dataSubjectEntity')
  at addDataSubjectForDetailsEntity (@cap-js/audit-logging/lib/utils.js:251:32)
  at _getDataModificationLogs (@cap-js/audit-logging/lib/modification.js:175:12)
  ...
❗️server shutdown ...❗️
```

CF router returns 502 (`x_cf_routererror: "endpoint_failure (EOF)"`). The instance auto-restarts ~20s later but the user just sees "Save failed: HTTP 502."

**Why:** Per CAP `@PersonalData` docs, `IsPotentiallyPersonal` is only valid on `DataSubject` / `DataSubjectDetails` entities (where the plugin can find a parent DataSubject's identifying field). On `'Other'`, the field-level tag implies a DataSubject context that doesn't exist.

**How to apply:**
1. For `EntitySemantics: 'Other'` entities, use **only** the entity-level annotation — no field-level `@PersonalData.IsPotentiallyPersonal`. The 'Other' semantic alone is sufficient to register CRUD audit-event capture.
2. If you DO need to mark a field, the only valid annotation on 'Other' is `@PersonalData.FieldSemantics: 'DataSubjectID'` on the FK to the actual DataSubject (when the entity references one).
3. **Tests must exercise the AdminService PROJECTION**, not the raw entity. `INSERT.into(cds.entities(...).MyEntity)` bypasses the audit-logging CRUD interceptor; `srv.tx().create('MyEntity')` on the service triggers it. PR #549's regression test is the canonical pattern.

Caught Tom 2026-06-22 on first DEV bootstrap of the Secrets UI under PR #542 (the prior 8 tests for Secrets covered the 4 custom ACTIONS via raw INSERTs, which never fired the plugin).

Related: [Anonymization handler uses a hardcoded entity allowlist](#anonymization-handler-uses-a-hardcoded-entity-allowlist) (same plugin, different fussiness), [CDS CSN: flat dotted keys vs nested annotation objects](#cds-csn-flat-dotted-keys-vs-nested-annotation-objects) (test against the real .cds), [Default-OFF feature flags need a live smoke before merge](#default-off-feature-flags-need-a-live-smoke-before-merge) (bootstrap-only paths need live deploy smoke).

---

## OData bound action binding mode: collection vs instance

OData bound actions have two distinct binding modes that affect how clients invoke them:

- **Collection-bound** (CDS: `@cds.odata.bindingparameter.collection` on the action): runtime expects `POST /Service/Entity/Service.Action`. Used for List Report toolbar actions (multi-row apply) and bulk-operation actions.
- **Instance-bound** (CDS: NO annotation, default): runtime expects `POST /Service/Entity(key=...)/Service.Action`. Used for OP header actions and per-row table actions.

Mismatch is a HARD runtime error from the OData adapter:

```
Action "<name>" must be called on a collection of <Service>.<Entity>
```
or
```
Action "<name>" must be called on an instance of <Service>.<Entity>
```

Tom 2026-06-18 (PR #414) hit the first variant: AdminService.uploadPhoto was annotated `@cds.odata.bindingparameter.collection`, but the press handler in the OP header invoked from a single-row binding context. The fix was to drop the annotation; instance-bound is the default and matches OP header context.

**Why:** CAP's CDS-to-OData translator emits different `Action` metadata depending on the annotation:
- collection-bound → `<Action><Parameter Name="..." Type="Collection(MyEntity)"/></Action>`
- instance-bound → `<Action><Parameter Name="..." Type="MyEntity"/></Action>`

OData v4 verifies the binding parameter type at request time. The press call URL embeds the row key, so OData routes it as instance-bound. If the action's metadata says collection-bound, the verification fails before the action handler runs.

**How to apply:**
1. **Decide invocation site BEFORE writing the action**:
   - List Report toolbar / "Apply to all selected rows" / global service action → **collection-bound** (annotate)
   - OP header / row action / per-row context-menu → **instance-bound** (no annotation; default)
2. **Action handler can be the same code in both modes** — the ID extraction `req.params?.[0]?.ID || req.params?.[0]` works for either:
   - instance-bound: `req.params[0]` is `{ ID: '...', IsActiveEntity: true }` → `.ID` yields the key
   - collection-bound: `req.params[0]` is the bound entity name (e.g., `'Advocates'`) → fallback yields a string the handler can re-fetch from
3. **Manifest `press` references work the same in both modes** — UI5 just builds the right URL based on the action's metadata + the binding context.

Related: `feedback_ui5_controller_suffix_collision.md` (other FE V4 wiring trap); `project_developer_advocates_impl.md` (where this surfaced).

---

## check-cds-build-staging fails on csn.json diff after annotation changes

The `check-cds-build-staging.ts` CI step runs `cds build --production` and fails if the regenerated `db/last-dev/csn.json` differs from the committed copy. It fires on changes that look UI-only (annotation tweaks in `app/admin-annotations.cds`) because:

1. Changing `LineItem Value: primaryAccount_ID` (non-existent CSN element) to `Value: primaryAccount` drops a stale `extensions` block from `csn.json`.
2. Adding/removing `@Common.ValueList` annotations changes the CSN annotation shape.
3. Renaming the namespace declaration anywhere in scope.

CI symptom (PR #552, 2026-06-22):
```
[cds-build-staging] FAILED — `cds build --production` produced diffs in tracked artifacts:
  - db/last-dev/csn.json
```

**How to apply:** Before committing any change to `srv/admin-service.cds` or `app/admin-annotations.cds`, run:

```bash
npx cds build --production
git add db/last-dev/ db/src/
```

If you already pushed and CI flagged it:

```bash
git checkout <branch> && git pull
npx cds build --production
git add db/last-dev/ db/src/
git commit --amend --no-edit
git push --force-with-lease
```

The CI guard's purpose: `mbt build` regenerates artifacts at deploy time, so a forgotten regen ships correctly to production — but every developer pulling main sees a perpetually dirty working tree after `mbt build` (caught 2026-06-21, PR #521 captured missing #518 artifacts). The guard prevents the dirty-tree regression.

Note: CI may also report a namespace diff (`com.sap.developers.ims` → `com.sap.developers.ims.shared`) that doesn't reproduce locally on Windows — it's a build-environment artifact, ignore. The csn.json `extensions` diff is the real signal.

Related: `feedback_check_srv_qa_when_changing_srv.md`, `feedback_hdiconfig_top_level_vs_gen.md`.

---

## Commit cds build artifacts alongside schema.cds changes

PR #518 (Steps.tutorial NOT NULL) changed `db/schema.cds` but didn't include the generated artifacts that record that change:
- `db/last-dev/csn.json` — `cds.persistence.journal` baseline that adds the `"notNull": true` flag
- `db/src/com.sap.developers.ims.Steps.hdbmigrationtable` — version bump and `ALTER ... NOT NULL` statement

Both are deterministic outputs of `cds build --production`. They DO land in the repo on every previous schema PR (last-dev/csn.json reached back through #517 → #466 → many earlier). They were missing in #518 because I committed before running `mbt build` (which calls `cds build` as a side effect). Followed up via PR #521.

**Why:** `mbt build` regenerates these every time, so the deployed HANA gets the constraint. But the repo looks "always uncommitted" on every machine that runs `mbt build` between commits. Tom hit this exact problem trying to pull #519 + #520 — the working tree wasn't clean.

**How to apply:** When a PR touches `db/schema.cds`, `srv/*.cds`, or any annotation file that affects CDS compile output:
1. Run `npx cds build --production` locally before `git push`
2. `git status` — anything under `db/last-dev/`, `db/src/*.hdbmigrationtable`, `db/src/_assoc.hdbsynonym`, `gen/db/src/gen/` should be staged in the same commit
3. Include them in the PR

The `cds build` step takes ~10s on a warm tree. Skipping it costs others a confused-working-tree moment every time.

Related: `feedback_deploy_cds_build_freshness.md`, `feedback_hugo_before_mbt.md`.

---

## Module singletons load twice under vitest + cds.test on Windows

When writing helpers for CAP services that hold module-level state (caches, singletons) that tests need to reset between cases, prefer reading the state on demand instead of caching it. The `cds.test('serve', ...)` interaction with vitest's transformer can load the same ESM module twice — same `import.meta.url`, two separate module instances. The test's `resetCache()` reaches one instance; the after-READ/before-WRITE hook in the running CAP service uses the other, with the stale value.

**Why:** Hit by `project_u14_skeletons.md`-style after-READ hook pattern in PR #29 (cfLogsUrl). `resetConfigCache()` from test file ran cleanly, but the admin-service's `buildCfLogsUrl()` saw a different `cachedConfig=null`, leaving cfLogsUrl null in OData responses. Confirmed via `console.log` at module top — file logged "MODULE LOADED" twice. Path normalization, vitest transformer, or CDS internals — root cause not isolated, but the workaround is reliable.

---

## `@assert.unique` on nullable columns + why khorosLogin isn't unique

CAP's `@assert.unique` is nullable-aware: NULL values are treated as distinct,
so a nullable column with `@assert.unique` permits any number of NULL rows
but rejects duplicate non-NULL values. We rely on this for `khorosId` (#566) —
unlinked users coexist freely, linked users can't collide.

We deliberately do **not** put `@assert.unique` on `khorosLogin`. Khoros has
bulk-renamed login slugs in the past (e.g. `j.doe` → `j_doe`).
A second user who claims a renamed slug while the first user's old slug
still sits in the DB would silently fail the join. `khorosId` is the stable
key; `khorosLogin` is a display label refreshed lazily every 6h.

**How to apply:** For helpers that wrap env-driven lookups (xsenv binding, env-var reads, file-based config) used by CAP service handlers and tested with `cds.test('serve', '--in-memory')`, default to re-reading on each call. xsenv itself doesn't cache — `serviceCredentials()` parses VCAP_SERVICES every call. The performance cost is negligible for admin-only after-READ hooks. If you genuinely need a cache (hot path, expensive lookup), use `globalThis` for the singleton — but try the no-cache version first. Also call `xsenv.loadEnv()` before `serviceCredentials()` to layer in any `default-env.json` (matches the `reference_cds_plugin_ui5.md` mail-client.js pattern).

---

## `cds.outbox.Messages` is framework-owned — bind via `cds.entities`, never hardcode column names

The `cds.outbox.Messages` entity backs CAP 10's Scheduling API status-column singleton lock (a row with `status='processing'` prevents concurrent scheduled ticks). App code MUST access it through:

```javascript
const outbox = cds.entities('cds.outbox');
if (!outbox?.Messages) return;                    // fail-open — CAP <10 or missing
const db = await cds.connect.to('db');
await db.run(DELETE.from(outbox.Messages).where({ target: `cron.${jobName}` }));
```

Never write raw SQL against `CDS_OUTBOX_MESSAGES`. The physical column names (`TASK`, `STATUS`) may change between CAP majors; CDS-level bindings track those renames automatically.

Stable observations across CAP 10.x:
- Field `target` (String) — for scheduled jobs, format is `cron.<jobName>`
- Field `status` (String) — `'processing'` while a row is picked up

The `test/hybrid/cron-service-schedule.test.js` reads the outbox broadly and filters in JS specifically because column-name casing may differ between HANA and SQLite. `srv/lib/scheduler-wedge.js` follows the same pattern.

**Never use `CDS_OUTBOX_MESSAGES` directly except in the HANA escape hatch documented at `docs/developers/operations/scheduler-troubleshooting.md`.**
