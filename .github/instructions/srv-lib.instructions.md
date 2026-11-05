---
applyTo: "srv/lib/**"
---
# srv/lib

- **srv-qa cp-list audit:** If you change anything here, re-walk the transitive `./` imports from `srv/lib/content-store.js`. Confirm that every dependency is in the `srv-qa` `cp` list in `.deploy/mta.yaml`. A missing dependency crashes QA at boot.
- `srv/lib/completion-rollup.js` is not a dependency of `content-store.js`. Group and mission completions are derived from rollups (see CLAUDE.md, "Completions rollup").
- Feature flags (`KG_*`, provenance, NGDS) fail open and default to OFF. Keep it that way.
- Run scoped tests for the module you touched: `npm test -- <pattern>`.
