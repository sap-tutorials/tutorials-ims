# Slug-lookup canonicalization audit (`check-slug-lookups.ts`)

**Status:** Design approved 2026-06-06. Implementation pending.

**Context:** [[feedback_audit_all_callers_of_buggy_primitive]] (issue #70 burned five PRs); [[project_211_anonymize_cascade_shipped]] for the analogous Tier-4 elimination of a different cross-file mismatch; existing `_tutorials-table.js` helper (HANA-vs-SQLite identifier mapping, NOT case-folding); table item #6 in the four-tier escalation discussion this session.

## Problem

Direct `where({ slug: <expr> })` lookups are case-sensitive on HANA. When `<expr>` comes from a request path or markdown front-matter, mixed case (`extend-RAP-App.md`) doesn't match the canonical lowercase row in HANA. The runtime symptom is "0 steps" or empty navigator — silent, no exception. This bug class:

- Cost 5 PRs on issue #70 (#86 / #94 / #113 / #123 / #126 / #128 — five fixes that didn't fix it before #128 redesigned).
- Has no compile-time link between the call-site string `slug` and the canonicalization helper `slug.toLowerCase()`.
- Is the textbook `string-A-equals-string-B-but-no-compiler` shape from the four-tier framework.

We already have a convention ([[feedback_audit_all_callers_of_buggy_primitive]]) — but the convention is reactive: it kicks in when a bug is reported, after damage. The team has 32 non-test `where({ slug ... })` call-sites today; nothing forces review of a 33rd.

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
| 4 | `where({ slug: lc<*> })` (variable name starting with `lc`) | yes | Already canonicalized at the source. |
| 5 | `where({ slug: { in: ... } })`, `where({ slug: { '!=': ... } })` (operator forms) | yes | Bulk / null operators — case-equality semantics differ. |
| 6 | Anything else (`where({ slug })`, `where({ slug: x })`, `where({ slug: row.slug })`) | **only with marker** | The bug-class case. |

The marker is `// slug-canonical: <reason>` on the same line OR the line immediately above. The reason is free-form; the check just records and prints it for audit. Reasons we expect: `pre-canonicalized`, `sentinel`, `caller-canonicalizes`, `version-keyed-not-slug-keyed`.

## Allowlist mechanism (the marker)

```js
// slug-canonical: caller-canonicalizes
const tutorial = await SELECT.one.from(dbTutorials).where({ slug });
```

OR same-line:

```js
const tutorial = await SELECT.one.from(dbTutorials).where({ slug }); // slug-canonical: caller-canonicalizes
```

The check is grep-level static analysis — no AST, no type inference. Marker discovery is a 2-line look-back from the matched lookup line. False positives are easy to silence with the marker; false negatives are impossible because every call-site needs a marker if it doesn't fit the auto-pass categories.

## Failure-mode messaging

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
```

Every miss cites file:line, prints the matched line, suggests the two fixes (annotate or canonicalize), and recommends a marker reason.

The OK-path summary line:

```
[check-slug-lookups] OK — 32 lookup(s) inspected; 4 marked, 8 sentinel, 4 pre-canonicalized, 4 operator-form, 12 auto-pass via lc-prefix or other rule.
```

(Counts illustrative; exact breakdown depends on the audit pass.)

## Audit pass

A single commit on this PR walks the 32 existing call-sites once. Each receives one of:

1. `// slug-canonical: <reason>` marker (expected: ~20 sites, mostly bare `where({ slug })` where the slug is canonical at the entry-point, e.g. `serveHandler` already lowercases before calling).
2. `.toLowerCase()` inline if the input is genuinely user-supplied + not canonicalized at any layer (expected: 0–2 actual bugs surfaced).
3. No change — already auto-passes (expected: ~10 sites).

The audit pass commit is intentionally separate from the check-script commit so the diff reads as: (1) here's the check + tests, (2) here's the existing call-sites correctly annotated.

## Out-of-scope follow-ups (referenced from PR description, not implemented here)

- **Tier-4 helper migration.** Introduce `srv/lib/find-tutorial-by-slug.js` that does `SELECT.one.from(Tutorials).where({ slug: slug.toLowerCase() })` and migrate the bare-lookup call-sites to it. The marker for those goes from `caller-canonicalizes` to disappearing entirely (no direct `.where({ slug })` left).
- **Hybrid HANA test asserting mixed-case input redirects correctly.** Test/coverage gap separate from the check.
- **`where({ slug:` audit inside admin Fiori Elements `.js` files.** Those are UI5 controllers, not DB lookups.

## Architecture

### File: `scripts/check-slug-lookups.ts`

Mirrors the structure of `check-icon-imports.ts` / `check-xs-app-mta.ts` / `check-srv-qa-cp-list.ts`:

- `parseSlugLookups(file, content): IconLookup[]` — pure function, parses one file's hits.
- `classifyLookup(line, prevLine, lookup): 'sentinel' | 'all-caps' | 'tolowercase' | 'lc-var' | 'operator' | 'marked' | 'unmarked'` — pure function, applies the rule table.
- `walkSrvDirs(): string[]` — collect every `.js`/`.cjs`/`.mjs` under `srv/`, `srv-qa/`, `scripts/`, excluding `__tests__/`.
- `checkSlugLookups(): CheckResult` — top-level, returns ok + counts + missing list.
- `main()` — guarded by `pathToFileURL` ESM idiom.

### File: `test/unit/check-slug-lookups.test.ts`

Spawn-based, env-var driven temp fixture root, mirrors the existing test pattern. ~8 tests:

1. Pass-path: marked + auto-pass mix.
2. Fails on a bare `where({ slug })` with no marker.
3. Sentinel `__nav__` auto-passes without marker.
4. ALL_CAPS constant auto-passes.
5. `.toLowerCase()` auto-passes.
6. `lc<*>` variable name auto-passes.
7. Operator form `{ in: slugs }` auto-passes.
8. Marker on the line above counts; marker 3 lines above does NOT.

### Wiring: `package.json`

Append to `postbuild:apps`:

```json
"postbuild:apps": "tsx scripts/check-build-collisions.ts && tsx scripts/check-icon-imports.ts && tsx scripts/check-slug-lookups.ts"
```

(Conflicts with PRs #267 / #270 are expected; whichever lands first, the others rebase the one-line append.)

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reviewers stamp `// slug-canonical: ok` reflexively, defeating the check | Medium | Failure message lists canonicalize-inline as the FIRST fix; marker name `slug-canonical:` (not `slug-ignore:`) keeps intent loud; `<reason>` is required (empty reason fails the check). |
| `lc<*>` heuristic false-positives | Low | Only saves 2 known call-sites from explicit annotation. If misused, the explicit marker still catches every other case. |
| New auto-pass pattern emerges (new operator form, new sentinel shape) | Low | Add one regex to the rule table; covered by the test expansion that comes with the PR adding the new pattern. |
| Audit pass mis-classifies a real bug as `caller-canonicalizes` | Low-medium | Reviewer of the audit-commit reads each `// slug-canonical:` line and confirms the claim. Catching mistakes is exactly what review is for. |

## Acceptance criteria

- [ ] `npm run build:apps` (or `npx tsx scripts/check-slug-lookups.ts`) exits 0 on current `main` after the audit pass.
- [ ] Removing one marker locally produces a failure with file:line and copy-pasteable fixes.
- [ ] All 8 unit tests pass.
- [ ] Wired into `postbuild:apps` so CI fails on a PR that adds an unmarked bare lookup.
