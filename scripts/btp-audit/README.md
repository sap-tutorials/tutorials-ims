# BTP → BAIP Homepage Content Audit

One-off data-cleanse pipeline: audit BTP references in Production homepage
descriptive text and rewrite them for the Business AI Platform rename.

Spec: `docs/superpowers/specs/2026-10-06-btp-baip-homepage-audit-design.md`

## Entities audited

HomepageShelves, VerbDefinitions, ShelfDefinitions, HomepageForYouCandidates,
HomepageFeaturedTopics (homepage descriptive text only).

## Rules

- Platform refs (BTP / SAP BTP / Business Technology Platform) → "SAP Business AI
  Platform" (first/prominent) or "Business AI Platform" (later). NEVER "BAIP".
- Tool names kept: BTP Cockpit, BTP CLI.
- "SAP BTP, <service>" → "<service>".
- Ambiguous → NEEDS_REVIEW (never auto-applied).

## Prerequisites

- `cf login` to the **prod** space; `cf target` must show the prod org/space.
- Export the expected target so the apply guard can assert it:
  ```bash
  export BTP_AUDIT_PROD_ORG=<prod-org>
  export BTP_AUDIT_PROD_SPACE=prod
  ```
- Prod AICore binding available for the classify step.

## Run order

```bash
# 1. Export candidates from prod (read-only)
npm run btp-audit:export            # → btp-audit/export.json

# 2. Classify with the LLM
npm run btp-audit:classify          # → btp-audit/report.md + btp-audit/changeset.json

# 3. REVIEW btp-audit/report.md.  Optionally hand-edit btp-audit/changeset.json
#    (e.g. flip a NEEDS_REVIEW to REPLACE with a chosen newValue, or set an
#     action to KEEP).

# 4. Dry run (no writes) — preview exactly what would change
npm run btp-audit:apply             # → btp-audit/applied.json (status would-apply)

# 5. Commit the changes to prod
npm run btp-audit:apply -- --commit # → btp-audit/applied.json (status applied)
```

## Safety

- `apply` is dry-run unless `--commit` is passed.
- On `--commit` against HANA it runs `cf target` and aborts unless org+space match
  `BTP_AUDIT_PROD_ORG` / `BTP_AUDIT_PROD_SPACE`.
- Optimistic concurrency: a field is written only if its current DB value still
  equals the `oldValue` captured at export time; anything edited since is skipped
  and recorded as `skipped-concurrent-edit`.
- Re-running `apply --commit` is idempotent (already-applied rows → `skipped-no-change`).

## Rollback

`btp-audit/applied.json` holds before/after for every written field. To revert,
build a changeset that swaps oldValue↔newValue for the `applied` records and run
the apply stage again.
