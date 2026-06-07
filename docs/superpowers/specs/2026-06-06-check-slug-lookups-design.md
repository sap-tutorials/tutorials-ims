# Slug-lookup canonicalization audit (`check-slug-lookups.ts`)

**Status:** Design approved 2026-06-06. Reviewer findings folded in 2026-06-06. Implementation pending.

**Context:** [[feedback_audit_all_callers_of_buggy_primitive]] (issue #70 burned five PRs); [[project_211_anonymize_cascade_shipped]] for the analogous Tier-4 elimination of a different cross-file mismatch; existing `_tutorials-table.js` helper (HANA-vs-SQLite identifier mapping, NOT case-folding); table item #6 in the four-tier escalation discussion this session.

## Problem

Direct `where({ slug: <expr> })` lookups are case-sensitive on HANA. When `<expr>` comes from a request path or markdown front-matter, mixed case (`extend-RAP-App.md`) doesn't match the canonical lowercase row in HANA. The runtime symptom is "0 steps" or empty navigator — silent, no exception. This bug class:

- Cost 5 PRs on issue #70 (#86 / #94 / #113 / #123 / #126 / #128 — five fixes that didn't fix it before #128 redesigned).
- Has no compile-time link between the call-site string `slug` and the canonicalization helper `slug.toLowerCase()`.
- Is the textbook `string-A-equals-string-B-but-no-compiler` shape from the four-tier framework.

We already have a convention ([[feedback_audit_all_callers_of_buggy_primitive]]) — but the convention is reactive: it kicks in when a bug is reported, after damage. The team has 30+ non-test `where({ slug ... })` call-sites today (the audit step computes the precise number and reports it via the OK-summary line); nothing forces review of a new one.

## Goal

Catch new `where({ slug: <expr> })` calls before they merge, with two failure modes:

1. **Bare lookup** (`where({ slug })` or `where({ slug: someVar })`) → fail unless an explicit allowlist marker explains why this call-site is safe.
2. **Auto-passing pattern** (sentinel, all-caps constant, `.toLowerCase()`, operator-form, or `lc<*>` variable) → silent pass.

Tier-1 (detect at build time) — Tier-4 (eliminate the duplication via a `findTutorialBySlug` helper) is the future direction but requires a 600+ LOC migration deferred to a follow-up PR.

## Non-goals

- **Tier-4 helper migration.** Out of scope for this PR per Tom's choice during brainstorming. A future PR can introduce `srv/lib/find-tutorial-by-slug.js` and migrate the bare-lookup call-sites; the marker mechanism is forward-compatible (those sites go from `// slug-canonical: caller-canonicalizes` to `findTutorialBySlug(slug)`).
- **Catching dynamic SQL strings.** The check is `where({ slug ... })`-shape only. Raw SQL strings escape the regex; that's accepted because raw SQL is also a much rarer pattern and tends to be reviewed manually.
- **Catching slugs in non-CDS contexts** (e.g. `if (req.params.slug === stored)`). Those are not the bug class we're fighting — the bug requires the lookup to land in HANA.
- **Auto-fixing.** The check reports and stops; humans decide whether to canonicalize or annotate.

## Detection rules

The check matches `\.where\s*\(\s*\{\s*slug\b` per line, then classifies each hit:

| # | Pattern | Auto-pass? | Reason |
|---|---|---|---|
| 1 | `where({ slug: '__<sentinel>__' })` (literal whose first chars are `'__`) | yes | Sentinel slug; not user-supplied. |
| 2 | `where({ slug: <ALL_CAPS_IDENT> })` | yes | Hardcoded constant like `SHELL_SLUG`. |
| 3 | `where({ slug: <expr>.toLowerCase() })` | yes | Canonicalized at call site. |
| 4 | `where({ slug: lc<*> })` (variable name starting with `lc`) | yes | Convention: `lc` prefix means "already called `.toLowerCase()`" (Hungarian-notation contract). Bypassable by misnaming — see Risks row. |
| 5 | `where({ slug: { in: ... } })`, `where({ slug: { '!=': ... } })` (operator forms) | yes | Bulk / null operators — case-equality semantics differ. |
| 6 | Anything else (`where({ slug })`, `where({ slug: x })`, `where({ slug: row.slug })`) | **only with marker** | The bug-class case. |

The marker is `// slug-canonical: <reason>` on the same line OR the line immediately above the line that contains the matched `where`. The reason is required (the check rejects an empty reason). Reasons we expect to see:

- `pre-canonicalized` — the value was `.toLowerCase()`'d at the source, just not via the auto-pass shape (e.g. `const stripped = path.toLowerCase().replace(...)`).
- `sentinel` — slug is a fixed magic string outside the auto-pass `__…__` shape.
- `caller-canonicalizes` — by contract, every caller of this function passes a lowercased slug. Document the contract in the function's JSDoc.
- `write-path-canonicalizes` — the slug value comes from iterating a payload that the write path already lowercased (e.g. `for (const [slug, body] of Object.entries(publishPayload))`).
- `version-keyed-not-slug-keyed` — the lookup is logically keyed on `version` and the `slug:` clause is just a join filter on a row whose canonical form was inserted by the same module.

## Allowlist mechanism (the marker)

```js
// slug-canonical: caller-canonicalizes
const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
```

OR same-line:

```js
const tutorial = await SELECT.one.from(dbTutorials).where({ slug }); // slug-canonical: caller-canonicalizes
```

For multi-line CDS query chains where `.where(...)` lives on its own line, the marker goes on the same line as `.where(...)` (NOT above the `SELECT.one`):

```js
const tutorial = await SELECT.one
  .from(dbTutorials)
  // slug-canonical: caller-canonicalizes
  .where({ slug });
```

The check is grep-level static analysis — no AST, no type inference. Marker discovery is a 2-line look-back from the matched lookup line (the matched line itself plus the immediately preceding line). False positives are easy to silence with the marker; false negatives are impossible because every call-site needs a marker if it doesn't fit the auto-pass categories.

## Failure-mode messaging

Three example call-sites covering the three most common shapes — user-input-shape, bare-shape, and write-path-iteration shape:

```
[check-slug-lookups] FAILED — 3 unmarked direct slug lookup(s):

  srv/lib/content-store.js:763
    .where({ slug: stripped })
    ^ unmarked. Either:
      - confirm `stripped` is .toLowerCase()'d at the source, then prefix:
          // slug-canonical: pre-canonicalized
      - or canonicalize inline:
          .where({ slug: stripped.toLowerCase() })

  srv/lib/breadcrumb-context.js:27
    .where({ slug })
    ^ unmarked. Either:
      - confirm caller passes a lowercased slug, then prefix:
          // slug-canonical: caller-canonicalizes
      - or canonicalize inline:
          .where({ slug: slug.toLowerCase() })

  srv/lib/content-publish-session.js:416
    .where({ slug }).columns('slug')
    ^ unmarked. If `slug` comes from iterating the publish payload (already
      lowercased by the write path), prefix:
          // slug-canonical: write-path-canonicalizes
      Otherwise canonicalize inline:
          .where({ slug: slug.toLowerCase() })
```

Every miss cites file:line, prints the matched line, suggests the two fixes (annotate or canonicalize), and recommends a marker reason.

The OK-path summary line is computed live from the run, NOT a fixed count, so it doesn't drift as the codebase grows:

```
[check-slug-lookups] OK — N lookup(s) inspected; M marked, S sentinel, T pre-canonicalized,
  O operator-form, L auto-pass via lc-prefix, A auto-pass via .toLowerCase().
```

## Audit pass

A single commit on this PR walks every existing non-test call-site once (count discovered live by the check on first run; ~30 at spec time). Each receives one of:

1. `// slug-canonical: <reason>` marker — most cases. The reason should match the call-site shape per the table above.
2. `.toLowerCase()` inline if the input is genuinely user-supplied + not canonicalized at any layer — expected: 0–2 actual bugs surfaced.
3. No change — already auto-passes via the rule table.

The audit pass commit is intentionally separate from the check-script commit so the diff reads as: (1) here's the check + tests, (2) here's the existing call-sites correctly annotated. Both commits land in the same PR (so CI sees a passing build at PR merge time), but a reviewer can read them independently.

## Out-of-scope follow-ups (referenced from PR description, not implemented here)

- **Tier-4 helper migration.** Introduce `srv/lib/find-tutorial-by-slug.js` that does `SELECT.one.from(Tutorials).where({ slug: slug.toLowerCase() })` and migrate the bare-lookup call-sites to it. The marker for those goes from `caller-canonicalizes` to disappearing entirely (no direct `.where({ slug })` left).
- **Hybrid HANA test asserting mixed-case input redirects correctly.** Test/coverage gap separate from the check.
- **`where({ slug:` audit inside admin Fiori Elements `.js` files.** Those are UI5 controllers, not DB lookups.

## Architecture

### File: `scripts/check-slug-lookups.ts`

Mirrors the structure of `check-icon-imports.ts` / `check-xs-app-mta.ts` / `check-srv-qa-cp-list.ts`:

- `parseSlugLookups(file, content): SlugLookup[]` — pure function, parses one file's hits.
- `classifyLookup(line, prevLine, lookup): 'sentinel' | 'all-caps' | 'tolowercase' | 'lc-var' | 'operator' | 'marked' | 'unmarked'` — pure function, applies the rule table. Marker reasons (when present) are recorded for the OK-summary breakdown.
- `walkSrvDirs(): string[]` — collect every `.js`/`.cjs`/`.mjs` under `srv/`, `srv-qa/`, `scripts/`. **Skips both `__tests__/` AND `node_modules/` directories** — the latter is critical because `srv-qa/node_modules/` is populated and would otherwise produce hundreds of false positives.
- `checkSlugLookups(): CheckResult` — top-level, returns `ok` + per-classification counts + the list of unmarked offenders.
- `main()` — guarded by `pathToFileURL` ESM idiom. **Includes a parser-drift sentinel**: if `walkSrvDirs` returns 0 files OR the regex matches 0 times across the entire codebase, the check exits 1 with an explanation that the regex or the walk has drifted from the source.

### File: `test/unit/check-slug-lookups.test.ts`

Spawn-based, env-var driven temp fixture root, mirrors the existing test pattern. **9 tests** (one more than originally planned to cover the empty-reason case):

1. **Pass-path** — marked + auto-pass mix; check exits 0.
2. **Bare `where({ slug })` with no marker** — fails with file:line.
3. **Sentinel `__nav__`** auto-passes without marker.
4. **ALL_CAPS constant** auto-passes.
5. **`.toLowerCase()`** auto-passes.
6. **`lc<*>` variable name** auto-passes.
7. **Operator form** `{ in: slugs }` auto-passes.
8. **Marker on the line above counts; marker 3 lines above does NOT.**
9. **Empty marker reason** (`// slug-canonical:`) is rejected as if no marker were present, surfacing the same failure message.

### Wiring: `package.json`

Append to `postbuild:apps`:

```json
"postbuild:apps": "tsx scripts/check-build-collisions.ts && tsx scripts/check-icon-imports.ts && tsx scripts/check-slug-lookups.ts"
```

(Conflicts with PRs #267 / #270 are expected; whichever lands first, the others rebase the one-line append.)

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reviewers stamp `// slug-canonical: ok` reflexively, defeating the check | Medium | Failure message lists canonicalize-inline as the FIRST fix; marker name `slug-canonical:` (not `slug-ignore:`) keeps intent loud; empty reason rejected (test #9). |
| `lc<*>` heuristic actively misused — author renames a non-canonicalized variable to `lcThing` to suppress the check | Low-medium | Document the convention: `lc<*>` is a Hungarian-notation contract that the value is already `.toLowerCase()`'d. The failure message + this design doc are the source of truth; misuse is reviewer-catchable on the same diff that introduces it. The check accepts that this heuristic is not bulletproof; its purpose is to save annotation noise on the existing 2 known call-sites. |
| New auto-pass pattern emerges (new operator form, new sentinel shape) | Low | Add one regex to the rule table; covered by the test expansion that comes with the PR adding the new pattern. |
| Audit pass mis-classifies a real bug as `caller-canonicalizes` | Low-medium | Reviewer of the audit-commit reads each `// slug-canonical:` line and confirms the claim. Catching mistakes is exactly what review is for. |
| `srv-qa/` is a Windows junction or symlink to `srv/` on some dev machines, causing duplicate walks | Low | `walkSrvDirs` uses `realpath`-deduplication on the visited set. If junction-induced duplicates leak through, they appear as duplicate file:line reports — annoying but not incorrect. |
| Parser regex drifts when CDS QL syntax evolves | Low | Parser-drift sentinel (mentioned in Architecture) — if 0 lookups are found, the check exits 1 with a message pointing the developer at the regex. |

## Acceptance criteria

- [ ] `npx tsx scripts/check-slug-lookups.ts` exits 0 on `main` after the audit pass commit lands. (Both commits — script + audit — must ship in the same PR so CI sees a green build at merge time.)
- [ ] Removing any marker locally produces a failure with file:line, the matched line, and the two copy-pasteable fixes.
- [ ] All 12 unit tests pass.
- [ ] An empty marker reason (`// slug-canonical:` with nothing after the colon) is rejected as if no marker were present.
- [ ] Wired into `postbuild:apps` so `npm run build:apps` (and CI) fails on a PR that adds an unmarked bare lookup.
- [ ] `srv-qa/node_modules/` is NOT scanned (verified by adding a synthetic third-party slug pattern there in a test fixture).
