# Assert Blocks → Verifiable Tutorials (parse + persist)

**Issue:** [sap-tutorials/tutorials-ims#2245](https://github.com/sap-tutorials/tutorials-ims/issues/2245), item **#2**.
**Date:** 2026-09-11
**Scope of this slice:** *parse + persist only.* No assertion **runner**, no CI execution, no verify.sh emission. Those are follow-ups (#3 installable Skills, #4 self-healing) that consume the artifacts this slice produces.

## 1. Goal

Let a tutorial author declare **machine-checkable postconditions** on a step — "after this step, `cds compile` exits 0", "`GET /catalog/Books` returns 200", "`srv/cat-service.cds` exists". This slice parses that authoring syntax into structured data and persists it two ways:

1. **Build artifacts** — public `asserts[]` in the Hugo step frontmatter + a server-only `<slug>.assert.json` sidecar in `.tutorial-cache/`.
2. **HANA** — `AssertSpecs` rows loaded through the existing content-publish endpoint pattern.

The output is the **dependency spine** for #3 (bundle asserts into a `verify.sh` inside an agent SKILL.md) and #4 (nightly self-healing runs the asserts). This slice deliberately stops before executing anything.

## 2. Non-goals

- Executing/grading assertions (runner). Out of scope; #3/#4.
- Emitting `verify.sh` or SKILL.md bundles. #3.
- Any UI surface (admin or learner-facing). Assertions are invisible in rendered content in this slice.
- New feature flag. Parsing is inert (unused data) until a consumer ships; no runtime behavior changes, so no flag is required. (If a later consumer needs gating, it owns its own flag.)

## 3. Precedent we mirror

This feature is structurally identical to **CodeCheck** (`[CODECHECK_N]`) — an author-supplied, per-step, machine-checkable spec. We follow its end-to-end pipeline exactly rather than invent a new one:

| Stage | CodeCheck (model) | AssertSpecs (this slice) |
|---|---|---|
| Parser | `scripts/parsers/codecheck.ts` (reads `rules.vr`) | **new** `scripts/parsers/assert.ts` (reads `rules.vr`) |
| Step field | `TutorialStep.codeCheck` | **new** `TutorialStep.asserts?: AssertBlock[]` |
| Attach + sidecar | `attachCodeCheckSpecs(steps, map)` at `fetch-tutorials.ts:1100-1112` | **new** `attachAssertSpecs(steps, map)`, mirror block |
| Frontmatter emit | `render-frontmatter.ts` whitelist (~L127-141) | add `asserts` to whitelist |
| Sidecar | `<slug>.codecheck.json` (`fetch-tutorials.ts` ~L1102) | **new** `<slug>.assert.json` |
| Collect+POST | `scripts/lib/publish-codecheck.js` | **new** `scripts/lib/publish-asserts.js` |
| Handler | `srv/lib/code-check-spec-publish.js` → `POST /content/code-check-specs` | **new** `srv/lib/assert-spec-publish.js` → `POST /content/assert-specs` |
| Route mount | `srv/server.js` L942 | add mount + import |
| Publish call | `publish-content.ts` L1348-1360 | mirror block |
| Entity | `CodeCheckSpecs` (`db/schema.cds:853`) | **new** `AssertSpecs` (`db/tutorial-asserts.cds`) |
| Journal | `db/persistence.cds` | add `AssertSpecs` entry |

## 4. Authoring syntax

**Location: the `rules.vr` companion file** — the same file that already holds `[VALIDATE_N]` and `[CODECHECK_N]` blocks, NOT the tutorial's step markdown. This is how every existing machine-checkable per-step spec is authored (`parseCodeCheckBlocks(rulesContent)` at `fetch-tutorials.ts:1100`). Because these markers never appear in the step body, there is **no body-stripping to do** — `scripts/parsers/v2.ts` is untouched. (An earlier draft of this spec wrongly claimed v2 strips `[CODECHECK_N]` from the body; it does not — codecheck lives in `rules.vr`.)

`N` = the **step number** the assertion applies to (matching `[CODECHECK_N]`/`[VALIDATE_N]`, where `[CODECHECK_3]` targets step 3). A step may carry multiple assertions: repeat the `[ASSERT_N]` block with the same `N`. Each block is one assertion; its `assertIndex` is assigned by order of appearance within that step (0-based).

Three types, each with its own required/optional subsections. `###Match` (a regex) is optional everywhere except `file`+`contains` where it is required.

**cmd** — run a shell command, assert exit code:
```
[ASSERT_1]
###Type
cmd
###Run
cds compile srv
###Expect
exit 0
###Match
Deployed        (optional: regex applied to stdout)
```

**http** — issue a request, assert status:
```
[ASSERT_2]
###Type
http
###Method
GET
###Path
/catalog/Books
###Expect
status 200
###Match
"value"         (optional: regex applied to response body)
```

**file** — assert a file exists, or contains text:
```
[ASSERT_3]
###Type
file
###Path
srv/cat-service.cds
###Expect
exists          (or: contains)
###Match
service CatalogService   (REQUIRED when Expect is "contains"; ignored for "exists")
```

### Grammar of `###Expect`

- `cmd`: `exit <int>` → `expectExit: number`.
- `http`: `status <int>` → `expectStatus: number`.
- `file`: `exists` → `expectContains: false`; `contains` → `expectContains: true` (+ required `match`).

Unknown `###Type`, missing required subsection, or unparseable `###Expect` ⇒ the individual block is **dropped with a `console.warn`**, never thrown. This matches the tolerant posture of `codecheck.ts`/`rules.ts` (a malformed block must never abort a tutorial build or a content publish).

## 5. Data model

`scripts/parsers/types.ts`:

```ts
export type AssertType = 'cmd' | 'http' | 'file';

export interface AssertBlock {
  index: number;        // assertIndex within the step, 0-based (order of appearance)
  stepNumber: number;   // N from [ASSERT_N]
  type: AssertType;
  // cmd
  run?: string;
  expectExit?: number;
  // http
  method?: string;      // GET|POST|PUT|PATCH|DELETE|HEAD, upper-cased
  path?: string;
  expectStatus?: number;
  // file
  filePath?: string;
  expectContains?: boolean;   // false ⇒ "exists" check; true ⇒ "contains" check
  // shared, optional
  match?: string;       // regex source string (stdout / body / file content)
}

export interface TutorialStep {
  // ...existing...
  asserts?: AssertBlock[];
}
```

There is **no server-only secret** in an assert block (unlike codecheck's `referenceSolution`), so the public frontmatter shape equals the full shape. The `<slug>.assert.json` sidecar exists purely so server-side consumers (#3/#4) can read specs without scraping Hugo frontmatter — same rationale as the codecheck sidecar.

## 6. Parser: `scripts/parsers/assert.ts`

Reads the `rules.vr` companion content (never the step body), mirroring `parseCodeCheckBlocks`. Two exports:

```ts
// N in [ASSERT_N] is the step number; a step may have multiple blocks.
export function parseAssertBlocks(content: string): Map<number, AssertBlock[]>
// Attaches public asserts[] to matching steps in place; returns the flat
// sidecar array (all blocks across all steps) for <slug>.assert.json.
export function attachAssertSpecs<T extends { number: number; asserts?: AssertBlock[] }>(
  steps: T[], specs: Map<number, AssertBlock[]>
): AssertBlock[]
```

- Marker regex `^\[ASSERT_(\d+)\]\s*$`; sibling-marker regex closes an open block when the next `[VALIDATE_|CODECHECK_|ASSERT_\d+]` line appears (same flush pattern as `codecheck.ts:12-28`).
- Per block: read `###Type`, then type-specific `###`-subsections via the existing `section(raw, name)` helper pattern; build+validate an `AssertBlock` per §4; assign `stepNumber = N`; append to `map.get(N)` (creating the array). `index` (assertIndex) = array position at append time.
- Malformed block ⇒ `console.warn` + skip (never throw).
- No fence-awareness needed — `rules.vr` is not rendered markdown, it is a directive file (matching `codecheck.ts`, which does not use a fence tracker).

## 7. Wiring

1. **`fetch-tutorials.ts`** — beside the codecheck block (`:1100-1112`), add: `const assertMap = parseAssertBlocks(rulesContent); if (assertMap.size) { const sidecar = attachAssertSpecs(steps, assertMap); if (sidecar.length) writeFileSync(join(CACHE_DIR, \`${t.slug.toLowerCase()}.assert.json\`), JSON.stringify({ slug: t.slug.toLowerCase(), specs: sidecar }, null, 2)); }`. `attachAssertSpecs` also sets `step.asserts` so frontmatter emit picks it up. No `compose.ts` change on the standard path; no `v2.ts` change.
2. **`compose.ts` (preview parity, optional-but-included)** — in the `opts.rulesVr` preview block (`:222-228`), add `const assertMap = parseAssertBlocks(opts.rulesVr); if (assertMap.size) attachAssertSpecs(steps, assertMap);` so author-preview shows asserts too. No sidecar write here (preview has no cache), matching how codecheck preview differs from fetch.
3. **`render-frontmatter.ts`** — add `if (s.asserts?.length) entry.asserts = s.asserts;` to the per-step whitelist (L128-139), emitted only when present.
4. **`scripts/lib/publish-asserts.js`** — `collectAssertSpecs(cacheDir)` (reads `*.assert.json`, flattens to `{slug, ...spec}`, defensive skip on malformed) + `publishAssertSpecs(baseUrl, apiKey, specs)` (POST `/content/assert-specs`, returns `{upserted, skipped}`). Direct clone of `publish-codecheck.js`.
5. **`srv/lib/assert-spec-publish.js`** — `assertSpecPublishHandler(req, res)`: validate `body.specs` (each needs `slug:string`, `stepNumber:number`, `type` ∈ enum, and type-specific required fields), then per spec resolve `Tutorials` by lower-cased slug (skip if absent), upsert `AssertSpecs` on `(tutorial_ID, stepNumber, assertIndex)` with **carry-forward** semantics (no DELETE). Clone of `code-check-spec-publish.js`.
6. **`srv/server.js`** — import handler; `app.post('/content/assert-specs', express.json({limit:'5mb'}), contentAuthMiddleware, assertSpecPublishHandler)` beside L942.
7. **`scripts/publish-content.ts`** — import + mirror the L1348-1360 collect/withRetry/publish block for asserts.

## 8. CDS entity

Defined **inline in `db/schema.cds`**, immediately after `CodeCheckSpecs` (~L870) — a faithful mirror of that entity (`: managed`, same declaration style). No separate `.cds` file, no new `using`.

```cds
// Author-supplied, machine-checkable step postconditions (issue #2245 item #2).
// Populated by the publish-content pipeline (carry-forward upsert); consumed
// by #3 (skill bundles) / #4 (self-healing). No secret columns — public == full.
entity AssertSpecs : managed {
  key tutorial     : Association to Tutorials;
  key stepNumber   : Integer;
  key assertIndex  : Integer;       // 0-based order within the step
  assertType       : String(8);     // 'cmd' | 'http' | 'file'
  run              : LargeString;   // cmd
  expectExit       : Integer;       // cmd
  httpMethod       : String(8);     // http
  httpPath         : LargeString;   // http
  expectStatus     : Integer;       // http
  filePath         : LargeString;   // file
  expectContains   : Boolean;       // file (false ⇒ exists check)
  matchRegex       : LargeString;   // shared, nullable
}
```

- Key `(tutorial, stepNumber, assertIndex)` — a step can hold multiple asserts, so `assertIndex` is part of the key (CodeCheckSpecs keys on just `(tutorial, stepNumber)`; called out because the upsert must key on all three).
- **Not journaled** (absent from `persistence.cds`), exactly like `CodeCheckSpecs`. Assert rows are fully regenerable from `rules.vr` on the next publish, so a DROP+CREATE on schema change loses nothing. This is a deliberate mirror of the analog, not an oversight — do not add a `@cds.persistence.journal` entry.
- Column named `assertType` (not `type`) and `httpMethod`/`httpPath` (not `method`/`path`) to avoid CDS keyword/reserved-name friction; `matchRegex` avoids overloading `match`. The JS `AssertBlock.type`/`method`/`path` map to these column names in the publish handler.

## 9. Deploy / ops guardrails (from repo memory)

- **srv-qa route drift:** `/content/assert-specs` is srv-only (a publish endpoint, like `/content/code-check-specs`). Add it to `ALLOWLIST_ONLY_ON_SRV` in `scripts/check-srv-qa-route-drift.ts` (~L73) and mirror the assertion in `test/unit/check-srv-qa-route-drift.test.ts`, or the drift guard fails CI.
- **srv-qa cp-list:** `srv/lib/assert-spec-publish.js` is imported by `srv/server.js`. Confirm it (and any `./` imports it adds) is present in `.deploy/mta.yaml`'s `srv-qa` `cp` list exactly as `code-check-spec-publish.js` is — a missing transitive dep crashes srv-qa boot at MTA deploy.
- **Route smoke:** add `{ path: '/content/assert-specs', method: 'POST' }` to `test/smoke/express-route-mutations.test.js` (~L22).
- **Schema build:** `AssertSpecs` is not journaled (like `CodeCheckSpecs`), so it compiles to a plain `.hdbtable`. Run `cds build --production` after adding the entity to confirm the model compiles and the artifact generates; nothing to hand-edit.
- **Seed-secrets doc:** append `/content/assert-specs` to the `CONTENT_API_KEY` description in `scripts/seed-secrets.cjs` L58 (cosmetic, keeps the endpoint list accurate).

## 10. Testing (all offline — no HANA)

Parse+persist is fully verifiable under `npm test` (in-memory SQLite + fixtures):

1. **Parser** (`test/unit/assert-parser.test.js`) — a `rules.vr` string exercising all three types + `###Match` + two `[ASSERT_N]` blocks on the same `N`; assert the returned `Map<number, AssertBlock[]>` shape (multi-assert step keyed by ascending `assertIndex`), and that `attachAssertSpecs` sets `step.asserts` on matching steps and returns the flat sidecar array. Negatives: unknown `###Type`, missing `###Run`, missing required `###Match` on `contains`, stray marker with no subsections (all warn-and-skip, no throw).
2. **Frontmatter emit** — compose a fixture tutorial, render frontmatter, assert `steps[].asserts` is present and correctly shaped, and absent when no asserts authored.
3. **Sidecar collect** (`test/unit/assert-publish-cli.test.js`) — mirror `code-check-publish-cli.test.js`: temp dir with `*.assert.json`, assert `collectAssertSpecs` flattens/skips malformed.
4. **Publish handler** (`test/unit/assert-spec-publish.test.js`) — mirror `code-check-spec-publish.test.js`: in-memory SQLite, 400 on invalid body/spec, upsert idempotency on re-post, skip on unknown slug, carry-forward (absent specs retained), multi-assert-per-step keying on `assertIndex`.

**Definition of done:** all four test groups green under `npm test`; `cds build --production` succeeds with the new entity; route-drift + smoke guards updated and passing. No deploy required to prove this slice.

## 11. Open questions resolved

- *How AssertSpecs rows load into HANA* — traced: the content-publish pipeline (`publish-content.ts` → `POST /content/<kind>-specs` → carry-forward upsert handler). Mirrored exactly; the entity is not a dangling definition.
- *Public vs server-only split* — none needed; asserts carry no secret. Sidecar retained only for server-side ergonomics.
