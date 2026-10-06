# BTP → BAIP Homepage Content Audit — Design

**Date:** 2026-10-06
**Status:** Approved design, pending implementation plan
**Author:** Tom (with Claude)

## Problem

As part of the SAP corporate rename from **BTP** to **Business AI Platform**, the
descriptive text on the developer-portal homepage must be audited and updated. This
copy (shelf titles/descriptions, shelf & verb explainers, "For You" candidates,
featured-topics editorial notes) is **stored as runtime rows in Production HANA** —
it is NOT in the repo's seed CSVs, and it is AI-seeded / hand-edited by admins through
the Fiori admin UI at `/admin-ui/#/homepage`.

The rename is **not** a blind find-and-replace. It needs intelligent, context-aware
classification because:

- Platform references change, but **tool names stay** (e.g. `BTP Cockpit`, `BTP CLI`).
- Some service names are prefixed `SAP BTP, <service>` and must become just `<service>`.
- The new name is **"Business AI Platform"** / **"SAP Business AI Platform"** —
  **never** abbreviated to "BAIP".
- Ambiguous prose must be surfaced for human decision, not guessed.

This is a one-off **data-cleanse** operation run directly against Production data.

## Scope

### In scope — 5 entities (all under `AdminService`, `@path '/admin'`)

| Entity | CDS file | Text fields audited |
|---|---|---|
| `HomepageShelves` | `db/homepage.cds:39` | `title`, `description`, `tagline`, `whyItMatters` |
| `VerbDefinitions` | `db/homepage.cds:134` | `label`, `tagline`, `whyItMatters` |
| `ShelfDefinitions` | `db/homepage.cds:150` | `label`, `tagline`, `whyItMatters` |
| `HomepageForYouCandidates` | `db/homepage.cds:169` | `title`, `description` |
| `HomepageFeaturedTopics` | `db/homepage-featured.cds:11` | `displayTitle`, `notes` |

### Explicitly out of scope

- Seed CSVs (`db/data/*.csv`) — the descriptive text is not there; a redeploy must not
  reintroduce it.
- The public `HomepageService` (`/homepage`) — read-only projection, no editable rows.
- Draft tables — we update the active rows directly.
- Any DB-stored descriptive text **outside** the homepage (Concepts, content pages,
  alerts, …) — deferred to a possible later pass.

## Classification Rules

The classifier (an LLM) assigns exactly one `action` to each candidate text field:

1. **REPLACE** — standalone platform reference (`BTP`, `SAP BTP`,
   `Business Technology Platform`) referring to the platform itself →
   - `SAP Business AI Platform` for the first / most prominent mention in a field,
   - `Business AI Platform` for subsequent mentions.
   - **Never** output "BAIP".
2. **KEEP** — recognized tool names left verbatim: `BTP Cockpit`, `BTP CLI`
   (extensible list). No write produced.
3. **STRIP_PREFIX** — `SAP BTP, <service name>` or `SAP BTP <service name>` →
   `<service name>`. e.g. `SAP BTP, Cloud Foundry runtime` → `Cloud Foundry runtime`.
4. **NEEDS_REVIEW** — ambiguous phrasing, novel wording, or a possible new/unknown tool
   name. Surfaced in the report for Tom's manual decision; **never auto-applied**.

The classifier returns, per candidate field: `action`, proposed `newValue` (null for
KEEP/NEEDS_REVIEW), and a one-line `rationale`.

## Architecture

Three workstation scripts under `scripts/btp-audit/`, all executed via
`cds bind --exec` so they run against **Production** service bindings. Pipeline:
**export → classify → apply**, with a mandatory human review gate before apply.

```text
prod HANA ──(SELECT)──> export.ts ──> btp-audit/export.json
                                           │
prod AICore ──(@cap-js/ai)──> classify.ts ─┤──> btp-audit/report.md      (human reads)
                                           └──> btp-audit/changeset.json  (machine applies)
                                           │
                              [ HUMAN REVIEW GATE — Tom approves / edits ]
                                           │
prod HANA ──(UPDATE)──> apply.ts ──> btp-audit/applied.json  (before/after audit log)
```

### 1. `scripts/btp-audit/export.ts` (read-only)

- Runs under `cds bind --exec` against prod HANA.
- `SELECT`s the in-scope fields from the 5 entities, **pre-filtered** to rows where any
  audited field matches `/btp|business technology platform/i` (case-insensitive) — so
  only genuine candidates are carried forward.
- Writes `btp-audit/export.json`: an array of candidate records, each keyed by
  `(entity, key, field)` with the current `value`.
- Safe to run anytime; no mutation.

### 2. `scripts/btp-audit/classify.ts`

- Runs under `cds bind --exec` with a **local binding to the prod AICore service**
  instance, using the project's `@cap-js/ai` idiom (AICore-btp). No new endpoint, no
  raw API key handling.
- For each candidate field, prompts the model with the four rules (full field value as
  context so prominence/tool-name/service-prefix can be judged in situ).
- Emits:
  - `btp-audit/report.md` — human-readable, grouped by entity then by action, showing
    old → new, rationale, and a clearly separated NEEDS_REVIEW section.
  - `btp-audit/changeset.json` — machine-applyable: `{entity, key, field, oldValue,
    newValue, action, rationale}`. KEEP and NEEDS_REVIEW rows carry no `newValue`.

### 3. `scripts/btp-audit/apply.ts`

- Runs under `cds bind --exec` against prod HANA.
- **Dry-run by default**; requires explicit `--commit` to write.
- **Guards:**
  - Aborts unless `cf target` shows the expected prod org/space (prevents dev→prod
    drift per CLAUDE.md).
  - **Optimistic concurrency**: per field, `UPDATE` only where the current DB value
    still equals the recorded `oldValue` — any row edited since export is skipped and
    reported, never clobbered.
  - Applies only `REPLACE` and `STRIP_PREFIX` rows; `KEEP` and `NEEDS_REVIEW` never
    written.
  - Parameterized CQL via `db.run()` — **no raw SQL string concatenation**
    (CLAUDE.md hard rule).
- Writes `btp-audit/applied.json`: per-field `{entity, key, field, oldValue, newValue,
  status}` where status ∈ {applied, skipped-concurrent-edit, skipped-no-change}.

### Human Review Gate

Between classify and apply, Tom reviews `report.md`. He may hand-edit
`changeset.json` — e.g. flip a `NEEDS_REVIEW` into a `REPLACE` with a chosen value, or
downgrade a `REPLACE` to `KEEP`. `apply.ts` consumes whatever is in `changeset.json`
at run time, so manual edits are honored.

## Data Flow

1. `cds bind --exec -- node scripts/btp-audit/export.ts` → `export.json`
2. `cds bind --exec -- node scripts/btp-audit/classify.ts` → `report.md` + `changeset.json`
3. Tom reviews `report.md`, optionally edits `changeset.json`.
4. `cds bind --exec -- node scripts/btp-audit/apply.ts` (dry-run) → preview + `applied.json` (status=would-apply)
5. `cds bind --exec -- node scripts/btp-audit/apply.ts --commit` → writes prod, final `applied.json`

## Error Handling

- **Prod-target drift:** `apply.ts` reads `cf target` and aborts if org/space ≠ expected
  prod values (configurable, defaults asserted). Export/classify also warn if not bound
  to prod.
- **Concurrent edits:** value-match guard skips and records, never overwrites.
- **AICore failure / malformed model output:** classify fails that record as
  `NEEDS_REVIEW` with the error as rationale rather than aborting the whole run; partial
  `report.md` still produced.
- **Idempotency:** re-running `apply.ts` after a partial run is safe — already-applied
  rows no longer match their `oldValue` and are skipped as `skipped-no-change`.
- **Rollback:** `applied.json` contains before/after for every written field; a reverse
  changeset can be synthesized from it if a rollback is needed.

## Testing

- **Unit (in-memory SQLite, `npm test`):** seed the 5 entities with representative rows
  (platform ref, tool name, service prefix, ambiguous, clean) and assert:
  - `export.ts` filter selects only candidate rows.
  - classification rule application (mock the AI call) maps each fixture to the correct
    action and `newValue`.
  - `apply.ts` writes REPLACE/STRIP_PREFIX, skips KEEP/NEEDS_REVIEW, honors the
    value-match guard (simulate a concurrent edit → skipped), and respects dry-run.
- **Manual prod rehearsal:** run export + classify against prod (read-only), review the
  real `report.md`, then `apply.ts` dry-run before `--commit`.

## Open Questions / Follow-ups

- Extend the KEEP tool-name list as more official BTP-branded tool names surface.
- A later pass may audit non-homepage DB-stored descriptive text (Concepts, pages,
  alerts) reusing the same export→classify→apply harness.
