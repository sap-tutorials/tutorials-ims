# Test hygiene — derive test literals from source-of-truth constants

> **Filed under issue #1089.** Two main-red incidents in short order came from
> the same class of bug: a source-of-truth constant (vocab, enum, seed CSV row
> set) grew legitimately in one PR, and a test assertion in a *different* file
> encoded the old shape as a bare integer literal. This doc codifies the
> pattern that keeps the assertion in lock-step with the vocab.

## The rule

**When a test asserts a count that reflects a domain vocabulary, enum, or
seed-data set, import the source-of-truth constant and derive the count.**

```js
// Before — brittle. Vocab grows in PR A, test breaks on main after merge.
import { describe, it, expect } from 'vitest';

it('returns 13 tags', () => {
  expect(items).toHaveLength(13);
});

// After — assertion tracks the vocab. Growing PROFILE_VOCAB simultaneously
// bumps items.length AND the expectation. CI stays green.
import { KNOWN_TAGS } from '../../srv/lib/homepage/persona-tag-validator.js';

it('returns one row per KNOWN_TAG', () => {
  expect(items).toHaveLength(KNOWN_TAGS.length);
  expect(new Set(items.map((r) => r.tag))).toEqual(new Set(KNOWN_TAGS));
});
```

## Source-of-truth constants (July 2026)

These are the modules to import from — each holds the canonical shape and
should be reused rather than duplicated in tests, docs, or fixture files.

| Domain | Constant | Module |
|---|---|---|
| Profile vocab (role, cloud, deployment, region) | `PROFILE_VOCAB`, `PROFILE_FIELDS` | `srv/lib/branch/profile-fields.js` |
| Persona-tag namespace (derived from `PROFILE_VOCAB`) | `KNOWN_TAGS` | `srv/lib/homepage/persona-tag-validator.js` |
| Homepage verb registry | `VERB_DEFAULTS`, `VERB_KEYS_SORTED` | `srv/lib/homepage/verb-shelf-defaults.js` |
| Homepage shelf registry | `SHELF_DEFAULTS`, `SHELF_KEYS_SORTED` | `srv/lib/homepage/verb-shelf-defaults.js` |
| Persona → verb-order map | `BASE_ORDER` | `srv/lib/homepage/persona-map.js` |
| Cross-corpus render cap in KG neighborhood merge | `MAX_OTHER_RESOURCES` | `srv/lib/kg-neighborhood-merge.js` |
| KG corpus type/priority table | `RESOURCE_TYPE_CONFIG` | `srv/lib/kg-resource-type-config.js` |
| Live event-type registry | `EVENT_TYPES` | `srv/lib/events/index.js` |
| AuthorService analytics entity picker (curated set) | `AUTHOR_EXPOSED_ENTITIES` | `srv/lib/author-exposed-entities.js` |

If your domain isn't listed and you're about to hardcode a count of N in a test
where N reflects the shape of a module-level array/enum, promote the constant
first, then derive.

## What NOT to convert

Not every integer literal in a test is a candidate. Leave these alone:

- **Fixture counts** — the test itself seeds 3 rows, the assertion checks 3.
  The count is local to the file and doesn't move.
- **Function-signature contracts** — `mw.length === 3` (Express middleware
  arity), `func.length === 2`.
- **Column-width / truncation caps** — `slug.length === 200`,
  `message.length === 2000`. These encode DB-level pins; the test is the
  drift guard against schema drift.
- **Explicit drift guards** — where the test's *purpose* is to freeze the
  cardinality (e.g. "predicate → count-field mapping has exactly 9 keys",
  "@assert.unique enum has exactly these three region values"). The
  hardcoded literal is the drift signal.
- **Historical row counts** — "3 LegacyRedirects seeded in the migration
  from IMS". Anchored to a one-time backfill; hardcoding is intentional.

When in doubt, add a comment (`// FROZEN — this cardinality is the contract`)
so the next audit doesn't sweep it up.

## Optional linter guard

An ESLint / Vitest-beforeAll rule could flag files that:

1. Import a symbol matching `/^KNOWN_/`, `/_VOCAB$/`, `/_DEFAULTS$/`, `/_FIELDS$/`, `/_TAGS$/`, or `/_KEYS(_SORTED)?$/`,
2. AND contain `toHaveLength(<int>)` or `.length).toBe(<int>)` where `<int> > 0`.

Weak signal — many co-imports are unrelated to the assertion — but cheap to
add and catches the exact PR shape that motivated issue #1089.

## Audit log

The full `test/` + `srv/__tests__/` sweep for issue #1089 ran 2026-07-11
(~440 `toHaveLength(<N>)` + ~124 `.length).toBe(<N>)` occurrences scanned).
Nearly all are safe (fixture counts, `toHaveLength(0)`, HTTP status arrays,
column-width caps, embedding-vector widths, pagination/batch sizes). The
converted candidates:

| File | Was | Now derives from |
|---|---|---|
| `test/integration/homepage/persona-tag-choices.test.js` | `toHaveLength(13)` | `KNOWN_TAGS.length` (PR #1088) |
| `test/unit/srv/admin-service-explainer-autoinit.test.js` | `toBe(7)` / `toBe(4)` | `VERB_DEFAULTS.length` / `SHELF_DEFAULTS.length` (prior #1089 work) |
| `test/hybrid/{verb,shelf}-definitions-crud.test.js` | `toBe(7)` / `toBe(4)` | `VERB_DEFAULTS.length` / `SHELF_DEFAULTS.length` (prior #1089 work) |
| `test/unit/srv/admin-service-explainer-actions.test.js` | `toBe(7)`, `toBe(5)` | `VERB_DEFAULTS.length`, `VERB_DEFAULTS.length - 2` |
| `test/unit/author-service-analytics.test.js` | `toHaveLength(9)` | `AUTHOR_EXPOSED_ENTITIES.length` |
| `test/hybrid/617-author-tutorials.test.js` | `toHaveLength(9)` | `AUTHOR_EXPOSED_ENTITIES.length` |

Deliberately **left as frozen drift guards** (converting would defeat their
purpose — see "What NOT to convert"):

- `test/unit/kg-graph-rebuild-predicate-counts.test.js` — `toBe(9)` on the
  `PREDICATE_TO_COUNT_FIELD` map size is *itself* the canary that fails CI when
  a projection predicate is added without a count column.

## Flake audit (#2813) — "CI flake" that was a deterministic signature regression

> **Filed under issue [#2813](https://github.com/sap-tutorials/tutorials-ims/issues/2813).**
> Same class as #1089 (a source-of-truth shape grew in one PR; a test in a
> *different* file encoded the old shape), one layer up: a **function signature**
> widened, and a stale test kept calling the old shape.

### What happened

`scripts/__tests__/backfill-images-slug-filter.test.ts > restricts enumeration
to the target slug` read as a CI flake (`expected [] to deeply equal ['beta']`,
intermittent, only in the 4-worker forks pool, survived `retry:1`). PR #2812
diagnosed it as a non-hermetic `beforeAll` fixture + async-import-shim timing
race and shipped a `beforeEach` rewrite + a shim-resolution guard.

**That diagnosis was wrong.** The test fails **1/1 locally in isolation** — it is
deterministic. Root cause: PR #2805 (`48da7d835`) widened

```diff
- export function collectImageUrls(publicDir: string, slug?: string)
+ export function collectImageUrls(publicDir: string, slugs?: string[])
```

and updated the production call site and the *new* `.js` sibling test
(`test/unit/backfill-images-slug-filter.test.js`, which calls with arrays), but
left this older `.ts` test passing a bare string `'beta'`. The impl does
`for (const s of slugs?.length ? slugs : readdir(...))`; a string has truthy
`.length` and **iterates by character** (`'b','e','t','a'`) → no matching dirs →
empty map. `retry:1` then re-ran it, it lost again, and the plausible
"Node22/Vitest-4 forks pool" story made a dead signature read as noise.

#2812's guard (`expect(typeof collectImageUrls).toBe('function')`) was a **no-op**
for this bug — the binding *was* a function; the *call shape* was wrong.

### The fix (this PR)

- Call sites pass arrays (`['beta']`, `['does-not-exist']`), matching the #2805
  signature.
- The `beforeEach` guard now asserts the **call contract**, not just the binding:
  `expect(collectImageUrls(publicDir, ['beta']).size).toBe(1)`. A future
  signature/shape drift (string vs `string[]`, renamed param) fails loudly at the
  guard line instead of as a cryptic empty-map assertion. Verified: reverting any
  call to a bare string fails all 5 tests *at the guard*, not as a no-op.

### retry:1 policy decision — **keep it, scoped to the real failure**

The scope step the issue asked for (surface every retry-dependent pass) was run
against the **actual CI environment** by scanning the unit-tier log of the DEV
merge `fdceca151` (the commit that *contains* #2812 and still went red). Result:

- **Exactly one** `(retry xN)` marker in the whole 1490-file / 11,541-test run —
  `restricts enumeration to the target slug`, and it **lost both attempts**
  (`× … (retry x1)`). Summary: `1 failed | 1487 passed | 2 skipped`.
- There is **no swarm of timing flakes** hiding behind `retry:1`. The single
  retried test was the deterministic regression above.

So `retry:1` did **not** mask flake debt here — it masked a *real red*, by making
a deterministic failure look stochastic. **Recommendation: keep `retry:1`** (it
genuinely absorbs the cold-boot starvation blip the config comment documents —
the smoke tier has the same lever for the same reason) **but treat any
retried-*then-failed* test as a deterministic bug first**, not a flake: reproduce
it in isolation (`npx vitest run <file>`) before reaching for "it's the forks
pool". A test that needs a retry to go green, or fails both tries, is signal, not
noise. No config change is warranted on this evidence; the fix is diagnostic
discipline, codified here.

### Structural note — the flake *shape* is pervasive, so don't mechanically guard it

An audit of the suite for #2812's structural shape (per-file `beforeAll`/`afterAll`
shared fixture **and** reaching a module through the workspace-first async-import
shim) found the shape is **everywhere**, not rare: **119** modules contain the
shim (`try { await import('@tutorials/…') } catch { await import(<bundle>) }`),
**615** `test/**` files use `beforeAll`/`afterAll`, and **432** boot a shared CAP
fixture via module-level `cds.test()`. Hundreds of files have *both* ingredients
and are green. Bolting a contract guard onto all of them would be churn against a
hypothesis this audit **disproved** — the shim/`beforeAll` shape was not the cause
of the one real failure. Add a contract guard where a test's call shape can drift
from its SUT's signature (the pattern above), not everywhere the shim appears.


- Issue [#1089](https://github.com/sap-tutorials/tutorials-ims/issues/1089) — audit + convert
- PR [#1088](https://github.com/sap-tutorials/tutorials-ims/pull/1088) — the fix that motivated this pattern
- Issue [#1043](https://github.com/sap-tutorials/tutorials-ims/issues/1043) — CSV-column parallel gotcha (different mechanism, same class)
- Issue [#2813](https://github.com/sap-tutorials/tutorials-ims/issues/2813) — flake audit: the "CI flake" that was a deterministic `string`→`string[]` signature regression (see section above); PR [#2812](https://github.com/sap-tutorials/tutorials-ims/pull/2812) — the misdiagnosed first attempt
- [`cap-cds-gotchas.md`](./cap-cds-gotchas.md) — general CAP/CDS test-hygiene guidance
