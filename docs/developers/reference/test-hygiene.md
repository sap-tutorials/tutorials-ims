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

## Related

- Issue [#1089](https://github.com/sap-tutorials/tutorials-ims/issues/1089) — audit + convert
- PR [#1088](https://github.com/sap-tutorials/tutorials-ims/pull/1088) — the fix that motivated this pattern
- Issue [#1043](https://github.com/sap-tutorials/tutorials-ims/issues/1043) — CSV-column parallel gotcha (different mechanism, same class)
- [`cap-cds-gotchas.md`](./cap-cds-gotchas.md) — general CAP/CDS test-hygiene guidance
