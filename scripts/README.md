# scripts/

Build-time and one-shot operational scripts. See the project root `README.md` and `CLAUDE.md` for the full pipeline.

## Dev-data scripts

- `scripts/setup-dev-data.cjs` — populates slugs and cleans autotest data on a fresh DEV HANA deploy. Run with `npx cds bind --exec -- node scripts/setup-dev-data.cjs`.
- `scripts/seed-tutorial-meta.js` — seeds `TutorialMeta` records for dashboard testing. Run with `npx cds bind --exec -- node scripts/seed-tutorial-meta.js`.
- `scripts/backfill-tutorial-meta.js` — one-shot backfill for Tutorials without TutorialMeta. Run after deploying TutorialMeta auto-init.
