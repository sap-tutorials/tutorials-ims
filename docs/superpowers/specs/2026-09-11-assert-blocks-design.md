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
| Parser | `scripts/parsers/codecheck.ts` | **new** `scripts/parsers/assert.ts` |
| Step field | `TutorialStep.codeCheck` | **new** `TutorialStep.asserts?: AssertBlock[]` |
| Merge | `compose.ts` step loop | same |
| Frontmatter emit | `render-frontmatter.ts` whitelist (~L127-141) | add `asserts` to whitelist |
| Sidecar | `<slug>.codecheck.json` (`fetch-tutorials.ts` ~L1102) | **new** `<slug>.assert.json` |
| Collect+POST | `scripts/lib/publish-codecheck.js` | **new** `scripts/lib/publish-asserts.js` |
| Handler | `srv/lib/code-check-spec-publish.js` → `POST /content/code-check-specs` | **new** `srv/lib/assert-spec-publish.js` → `POST /content/assert-specs` |
| Route mount | `srv/server.js` L942 | add mount + import |
| Publish call | `publish-content.ts` L1348-1360 | mirror block |
| Entity | `CodeCheckSpecs` (`db/schema.cds:853`) | **new** `AssertSpecs` (`db/tutorial-asserts.cds`) |
| Journal | `db/persistence.cds` | add `AssertSpecs` entry |

## 4. Authoring syntax

Written inside a step's H3 body. The `[ASSERT_N]` marker line and its `###`-subsection lines are **stripped from rendered step content** (v2 already strips `[VALIDATE_N]`/`[CODECHECK_N]`/`[DONE]` — same mechanism, `scripts/parsers/v2.ts`). `N` is a per-step ordinal starting at 1.

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
  index: number;        // N from [ASSERT_N], 1-based, per step
  stepNumber: number;
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

Export `extractAsserts(stepContent: string, stepNumber: number): { content: string; asserts: AssertBlock[] }`.

- Fence-aware (reuse the fence tracker used by `codecheck.ts`/`v2.ts`) so `[ASSERT_N]` inside a ```` ``` ```` block is literal and never parsed.
- Scan for `^\[ASSERT_(\d+)\]$` marker lines; collect following `###Subsection` blocks until the next marker or a non-subsection content line.
- Build an `AssertBlock`, validate per §4, push or warn-and-skip.
- Return the step content with all matched marker+subsection lines removed (so rendered output is clean), plus the `asserts` array.

## 7. Wiring

1. **`compose.ts`** — in the v2 step-parse loop, call `extractAsserts(step.content, step.number)`, assign `step.content` (stripped) and `step.asserts` (when non-empty). Placed after existing per-step extractors (codecheck/validation) for consistent stripping order.
2. **`render-frontmatter.ts`** — add `asserts` to the per-step frontmatter whitelist (~L127-141), emitted only when present. Serialized via the same YAML path as `validation`/`codeCheck`.
3. **`fetch-tutorials.ts`** — after compose, collect `steps[].asserts` into `{ slug, specs: [...] }` and write `<slug>.assert.json` to `CACHE_DIR`, mirroring the codecheck sidecar write (~L1102). Only write when at least one assert exists.
4. **`scripts/lib/publish-asserts.js`** — `collectAssertSpecs(cacheDir)` (reads `*.assert.json`, flattens to `{slug, ...spec}`, defensive skip on malformed) + `publishAssertSpecs(baseUrl, apiKey, specs)` (POST `/content/assert-specs`, returns `{upserted, skipped}`). Direct clone of `publish-codecheck.js`.
5. **`srv/lib/assert-spec-publish.js`** — `assertSpecPublishHandler(req, res)`: validate `body.specs` (each needs `slug:string`, `stepNumber:number`, `type` ∈ enum, and type-specific required fields), then per spec resolve `Tutorials` by lower-cased slug (skip if absent), upsert `AssertSpecs` on `(tutorial_ID, stepNumber, assertIndex)` with **carry-forward** semantics (no DELETE). Clone of `code-check-spec-publish.js`.
6. **`srv/server.js`** — import handler; `app.post('/content/assert-specs', express.json({limit:'5mb'}), contentAuthMiddleware, assertSpecPublishHandler)` beside L942.
7. **`scripts/publish-content.ts`** — import + mirror the L1348-1360 collect/withRetry/publish block for asserts.

## 8. CDS entity

`db/tutorial-asserts.cds` (new file, imported from `db/schema.cds` or wherever content-shape CDS is aggregated — follow how `tutorial-freshness.cds` is included):

```cds
using { com.sap.developers.ims as ims } from './schema';

namespace com.sap.developers.ims;

entity AssertSpecs {
  key tutorial    : Association to ims.Tutorials;
  key stepNumber  : Integer;
  key assertIndex : Integer;      // N within the step
  type            : String(8);    // 'cmd' | 'http' | 'file'
  run             : String;       // cmd
  expectExit      : Integer;      // cmd
  httpMethod      : String(8);    // http
  httpPath        : String;       // http
  expectStatus    : Integer;      // http
  filePath        : String;       // file
  expectContains  : Boolean;      // file
  matchRegex      : String;       // shared, nullable
}
```

- Key `(tutorial, stepNumber, assertIndex)` — a step can hold multiple asserts, so `assertIndex` is part of the key (this differs from CodeCheckSpecs' single-per-step key; called out because the upsert must key on all three).
- Add `AssertSpecs` to `db/persistence.cds` (`@cds.persistence.journal`) so the migration table is generated — per the "new persisted entity needs `db/persistence.cds` entry" rule.
- Field names avoid the CDS reserved-ish `method`/`path` by prefixing `http`; `matchRegex` avoids overloading `match`.

## 9. Deploy / ops guardrails (from repo memory)

- **srv-qa route drift:** `/content/assert-specs` is srv-only (a publish endpoint, like `/content/code-check-specs`). Add it to `ALLOWLIST_ONLY_ON_SRV` in `scripts/check-srv-qa-route-drift.ts` (~L73) and mirror the assertion in `test/unit/check-srv-qa-route-drift.test.ts`, or the drift guard fails CI.
- **srv-qa cp-list:** `srv/lib/assert-spec-publish.js` is imported by `srv/server.js`. Confirm it (and any `./` imports it adds) is present in `.deploy/mta.yaml`'s `srv-qa` `cp` list exactly as `code-check-spec-publish.js` is — a missing transitive dep crashes srv-qa boot at MTA deploy.
- **Route smoke:** add `{ path: '/content/assert-specs', method: 'POST' }` to `test/smoke/express-route-mutations.test.js` (~L22).
- **Schema migration:** run `cds build --production` after adding the entity to regenerate the `.hdbmigrationtable`; never hand-edit it.
- **Seed-secrets doc:** append `/content/assert-specs` to the `CONTENT_API_KEY` description in `scripts/seed-secrets.cjs` L58 (cosmetic, keeps the endpoint list accurate).

## 10. Testing (all offline — no HANA)

Parse+persist is fully verifiable under `npm test` (in-memory SQLite + fixtures):

1. **Parser** (`test/unit/assert-parser.test.js`) — a fixture step body exercising all three types + `###Match`; assert the returned `AssertBlock[]` shape and that markers are stripped from `content`. Negatives: unknown `###Type`, missing `###Run`, missing required `###Match` on `contains`, `[ASSERT_N]` inside a fence (must be ignored), stray marker with no subsections.
2. **Frontmatter emit** — compose a fixture tutorial, render frontmatter, assert `steps[].asserts` is present and correctly shaped, and absent when no asserts authored.
3. **Sidecar collect** (`test/unit/assert-publish-cli.test.js`) — mirror `code-check-publish-cli.test.js`: temp dir with `*.assert.json`, assert `collectAssertSpecs` flattens/skips malformed.
4. **Publish handler** (`test/unit/assert-spec-publish.test.js`) — mirror `code-check-spec-publish.test.js`: in-memory SQLite, 400 on invalid body/spec, upsert idempotency on re-post, skip on unknown slug, carry-forward (absent specs retained), multi-assert-per-step keying on `assertIndex`.

**Definition of done:** all four test groups green under `npm test`; `cds build --production` succeeds with the new entity; route-drift + smoke guards updated and passing. No deploy required to prove this slice.

## 11. Open questions resolved

- *How AssertSpecs rows load into HANA* — traced: the content-publish pipeline (`publish-content.ts` → `POST /content/<kind>-specs` → carry-forward upsert handler). Mirrored exactly; the entity is not a dangling definition.
- *Public vs server-only split* — none needed; asserts carry no secret. Sidecar retained only for server-side ergonomics.
