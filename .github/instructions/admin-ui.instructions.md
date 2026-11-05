---
applyTo: "app/admin/**,app/admin-shell/**"
---
# Admin UI (SAPUI5 / Fiori Elements)

- Use the UI5 MCP server: `get_api_reference` for APIs, `run_ui5_linter` and `run_manifest_validation` before you finish.
- Components load as headless componentUsages inside the `sap.tnt.ToolPage` shell (`app/admin-shell/`). The theme is `sap_horizon`.
- **Deploy gate:** Admin UI changes need a full `npm run deploy -- --env <env>`. Don't use `--skip-build` or `-m` scoping, and never bypass Step 3.5 (`scripts/check-shipped-admin-bundle.cjs`). Without a full deploy, a stale admin UI ships.
- User-facing changes should come with an e2e spec (see `docs/developers/reference/e2e-coverage-pattern.md`).
