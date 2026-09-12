# Design: Tutorials as installable agent Skills (`GET /content/tutorials/:slug/skill`)

**Issue:** [#2245](https://github.com/sap-tutorials/tutorials-ims/issues/2245) item 3
**Depends on:** #2256 (signed provenance envelope), #2259 (assert blocks → parse + persist)
**Date:** 2026-09-11
**Status:** Approved design → implementation planning

## Goal

Turn a published tutorial into a capability an AI agent can *install and perform*, not just
read. `GET /content/tutorials/:slug/skill` returns a zip archive that unpacks to an
installable Skill directory: a `SKILL.md` procedure, a runnable `verify.sh` generated from
the tutorial's assert blocks, and a provenance/freshness stamp. This is item 3 of the
"executable, self-verifying, self-healing tutorials" spine — it composes the outputs of
items 1 (provenance) and 2 (assert blocks) that already shipped.

## Non-goals

- No new persistence. The endpoint is a pure read/compose over `getTutorialSource`,
  `AssertSpecs`, and `loadProvenanceInputs`.
- No actual execution of `verify.sh` server-side (that is item 4, self-healing).
- No per-code-sample separate files in v1 — code fences are carried inline in `SKILL.md`
  (YAGNI; revisit if an agent consumer needs standalone sample files).
- No QA-channel (`srv-qa`) support — published-content trust surface only, mirroring the
  provenance endpoint's rationale.

## Route & registration

- **Path:** `GET /content/tutorials/:slug/skill` — sibling of the existing
  `/content/tutorials/:slug/provenance` (#2256).
- **Registration:** plain Express route inside the `cds.on('bootstrap', (app) => {...})`
  block in `srv/server.js`, registered **before** the `/content/tutorials/*slug` wildcard
  (`serveHandler`) so the wildcard does not swallow it — same ordering discipline as
  `/provenance`.
- **Auth:** anonymous public read (no `contentAuthMiddleware`), consistent with tutorials
  and `/provenance`.
- **Drift guard:** add `'GET /content/tutorials/:slug/skill'` to `ALLOWLIST_ONLY_ON_SRV` in
  `scripts/check-srv-qa-route-drift.ts` with a rationale mirroring the provenance entry
  (published-content-only, no srv-qa reader).

## Feature flag

New DB feature flag in `srv/lib/feature-flags/registry.js`, following the
`PROVENANCE_ENVELOPE_ENABLED` shape exactly:

```js
{
  key: 'SKILL_BUNDLE_ENABLED', label: 'Installable Skill bundle endpoint', category: 'Content',
  kind: 'db', imsConfigKey: 'flag.skill.bundle',
  valueType: 'boolean', default: false, status: 'dev-only',
  description: 'When true, serves an installable agent-Skill zip at '
    + '/content/tutorials/:slug/skill (SKILL.md procedure + verify.sh generated from assert '
    + 'blocks + provenance/freshness stamp). Public, anonymous, read-only over PUBLISHED '
    + 'tutorials. DB-driven config (ImsConfig key flag.skill.bundle); no env var. Default OFF (#2245).',
  howToChange: featureFlagUpsert('SKILL_BUNDLE_ENABLED', 'flag.skill.bundle'),
}
```

Flag OFF → **404** (fail-closed on the feature; the endpoint should not advertise its
existence). Reading the flag reuses whatever helper `provenanceHandler` uses to read
`PROVENANCE_ENVELOPE_ENABLED` (confirm during implementation and mirror it).

## Handler module: `srv/lib/skill-bundle.js`

New module exporting a factory `createSkillBundleHandler(deps)` (for testability) and a
default `skillBundleHandler(req, res)` bound to production deps, mirroring the
provenance-handlers factory/default pattern.

Injectable deps (default to the real implementations):
- `getTutorialSource(slug)` — from `content-store.js` (raw markdown).
- `loadAssertSpecs(slug)` — new small helper (below).
- `loadProvenanceInputs(slug)` + `buildEnvelope(...)` — from provenance libs.
- `isFlagEnabled('SKILL_BUNDLE_ENABLED')`.

### Request flow

1. **Flag check** → 404 if disabled.
2. **Canonicalize slug** (lowercase; 301 redirect on non-canonical) — reuse the existing
   canonicalization helper used by `serveHandler`/`provenanceHandler`.
3. `getTutorialSource(slug)` → `{ markdown, sourceHash, contentHash }`. If `markdown` is
   null/absent (legacy or unknown slug) → **404**.
4. `loadAssertSpecs(slug)` → ordered `AssertSpec[]` (may be empty).
5. `loadProvenanceInputs(slug)`; if the provenance flag is on and inputs exist, `buildEnvelope`
   to obtain `{ jws, claims }`. **Fail-open**: any error or missing data → stamp degrades to
   `confidence: 'unknown'`, no `jws`. The Skill bundle never fails because provenance is off.
6. Compose `SKILL.md` and `verify.sh` strings (pure functions, below).
7. Stream a zip via `archiver` (already a declared dependency, `archiver@8.0.0`):
   - `Content-Type: application/zip`
   - `Content-Disposition: attachment; filename="<slug>-skill.zip"`
   - Entries: `<slug>/SKILL.md`, `<slug>/verify.sh` (mode `0o755`).
   - On `archiver` `error` event → 500 (if headers not yet sent) + `console.error`.

### `loadAssertSpecs(slug)` helper

Since #2259 added no read projection, read the entity directly:

1. `SELECT.one.from(Tutorials).columns('ID').where({ slug: lcSlug })` → if none, return `[]`.
2. `SELECT.from(AssertSpecs).where({ tutorial_ID: tut.ID }).orderBy('stepNumber','assertIndex')`.
3. Map DB columns back to the logical assert shape (reverse of the #2259 remapping):
   `assertType→type`, `httpMethod→method`, `httpPath→path`, `matchRegex→match`; keep
   `run`, `expectExit`, `expectStatus`, `filePath`, `expectContains`, `stepNumber`,
   `assertIndex`.

Entity access via `cds.entities('com.sap.developers.ims')`. Fail-open: on error, log and
return `[]` (bundle still ships, verify.sh has no checks).

## Composition (pure functions)

### `buildSkillMd({ slug, title, description, markdown, asserts, stamp })`

Returns a `SKILL.md` string:

- **YAML frontmatter:** `name: <slug>`, `description:` (tutorial title + short description,
  single-line, YAML-escaped). Frontmatter matches the agent-skill convention (name +
  description are what agents index for discovery).
- **Procedure body:** the tutorial's step content derived from `markdown`. Code fences are
  carried through inline as fenced blocks. Steps come from the parsed markdown structure
  (H2/H3 per parser v2 — reuse the existing step-parsing helper rather than re-parsing by
  hand; confirm the reusable entry point during implementation).
- **`## Verifying this Skill`** section: instructs the agent to run `bash verify.sh`
  (with `BASE_URL` when http asserts are present), and states how many automated checks
  are bundled.
- **`## Provenance & freshness`** section: `confidence`, `last-verified` date
  (`stamp.lastScanned`), `source-commit` (`stamp.sourceCommit`), and the JWS token when
  available (fenced), plus the JWKS URL for verification.

### `buildVerifyScript(asserts)`

Returns a bash script string:

- Header: `#!/usr/bin/env bash` + `set -euo pipefail`, a `fail()` helper, a pass/fail
  counter, and (only when any http assert exists) `BASE_URL="${BASE_URL:-http://localhost:4004}"`.
- One check block per assert, in `(stepNumber, assertIndex)` order, each echoing a labeled
  check line:
  - **cmd:** run `run`; capture output+exit; assert exit `== expectExit`; if `match`,
    `grep -Eq -- "<match>"` on captured output.
  - **http:** `code=$(curl -s -o /tmp/... -w '%{http_code}' -X <method> "${BASE_URL}<path>")`;
    assert `code == expectStatus`; if `match`, `grep -Eq` on the response body.
  - **file:** `test -f "<filePath>"`; if `expectContains`, `grep -Eq -- "<match>" "<filePath>"`.
- All interpolated values (`run`, `path`, `filePath`, `match`) are **shell-quoted** via a
  single-quote-escaping helper to prevent breakage/injection from spec content.
- **Empty asserts:** script echoes `"No automated checks defined for this tutorial."` and
  `exit 0`.
- Footer: print summary; `exit 1` if any check failed.

## Error handling

| Condition | Response |
|---|---|
| `SKILL_BUNDLE_ENABLED` off | 404 |
| Non-canonical slug | 301 → canonical `/skill` URL |
| Unknown / legacy slug (no source markdown) | 404 |
| Provenance off / no inputs / build error | 200, stamp `confidence: 'unknown'`, no JWS (fail-open) |
| AssertSpecs read error | 200, verify.sh with no checks (fail-open) |
| `archiver` stream error | 500 + logged (if headers unsent) |

## Testing

Follow existing patterns (`test/lib/provenance-endpoint.test.js`, `test/unit/provenance-*.test.js`,
`test/unit/assert-*.test.js`).

- **`test/unit/skill-bundle-compose.test.js`** — pure composition:
  - `buildVerifyScript`: one representative test per assert type (cmd exit + match, http
    status + method, file exists, file contains), multi-assert ordering, empty → `exit 0`
    notice, shell-quoting of a value containing quotes/`$`.
  - `buildSkillMd`: frontmatter has `name` + `description`; provenance section reflects
    `high`/`unknown` stamps; JWS included only when present.
- **`test/lib/skill-bundle-endpoint.test.js`** — handler via injected deps:
  - flag off → 404; unknown slug → 404; happy path → 200, `application/zip`,
    `Content-Disposition` filename; unzip (via `jszip`, already installed) and assert the
    two entries exist and `verify.sh` content matches the specs; provenance-off path still
    200 with degraded stamp.
- **Route/registration:** extend `test/smoke/express-route-mutations.test.js` and the
  drift-guard test (`test/unit/check-srv-qa-route-drift.test.ts`) for the new allowlist entry.

## Files touched

| File | Change |
|---|---|
| `srv/lib/skill-bundle.js` | **new** — handler factory + `buildSkillMd` + `buildVerifyScript` + `loadAssertSpecs` |
| `srv/server.js` | register `GET /content/tutorials/:slug/skill` before the `*slug` wildcard; import handler |
| `srv/lib/feature-flags/registry.js` | add `SKILL_BUNDLE_ENABLED` entry |
| `scripts/check-srv-qa-route-drift.ts` | add allowlist entry + rationale |
| `test/unit/skill-bundle-compose.test.js` | **new** |
| `test/lib/skill-bundle-endpoint.test.js` | **new** |
| `test/smoke/express-route-mutations.test.js` | extend for new route |
| `test/unit/check-srv-qa-route-drift.test.ts` | extend for new allowlist entry |

## Open items to confirm during implementation

1. The exact reusable slug-canonicalization helper and flag-read helper used by
   `provenanceHandler` (mirror, don't reinvent).
2. The reusable markdown→steps parsing entry point for `buildSkillMd` (parser v2 uses H3
   steps); if none is cleanly importable server-side, fall back to emitting the raw markdown
   body verbatim under the procedure section (still valid; less structured).
3. Whether `srv-qa`'s `content-store.js` cp-list is affected — `skill-bundle.js` is a new
   `srv/lib` module but is **not** a transitive `./` import of `content-store.js`; it imports
   *from* content-store. Confirm it is added to the `srv` module only (not srv-qa) and that
   the drift guard covers the route.
