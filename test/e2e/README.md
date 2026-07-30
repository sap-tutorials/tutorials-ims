# Playwright e2e specs (`e2e` Vitest project)

Sixth Vitest project, driven by `playwright-core` + `chromium.launch()` inside plain vitest — the same pattern the `a11y` project uses. Deliberately NOT `@playwright/test` (no new runner dependency). Closes the admin-UI coverage gap from issue #1338 (salvaged from #806).

## What this tier covers

One happy-path smoke assertion per surface. Intentionally narrow — load-proves the approuter → CAP → HANA plumbing, not CRUD flows.

| Spec | Path exercised | Auth |
|---|---|---|
| `tutorial-serve.test.js` | `/tutorials/:slug` → CAP content-serve → HANA BLOB | anonymous |
| `admin-shell.test.js` | `/admin-ui/#missions` (XSUAA) → sap.tnt.ToolPage shell → CAP `/admin` OData | Basic |
| `scanner.test.js` | `/scanner-ui/` (XSUAA scope `MobileApp`) | Basic |
| `analytics-explorer.test.js` | `/analytics-ui/` (XSUAA) → Vue 3 SPA → CAP `/admin/analytics` | Basic |
| `display-app.test.js` | `/display-app/` (XSUAA scope `DisplayApp`) → Socket.IO `/ws/display` | Basic |

All specs self-skip with no output when `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` is absent — `npm test` (unit tier) is unaffected.

## Running locally against a deployed env

```bash
export PLAYWRIGHT_BASE_URL="https://<dev-approuter>.cfapps.<region>.hana.ondemand.com"
export SMOKE_TECH_USER="<tech-user>"
export SMOKE_TECH_PASSWORD="<tech-password>"

# One-time: install the headless Chromium shell
npx playwright install --with-deps chromium

# All five specs
npm run test:e2e

# One spec at a time
npx vitest run --project e2e test/e2e/tutorial-serve.test.js
```

The unauthenticated `tutorial-serve` spec runs with just `PLAYWRIGHT_BASE_URL` — no credentials needed.

## Running locally against a hybrid dev server

```bash
# Terminal 1 — local CAP + approuter
npm run dev:hybrid

# Terminal 2
export PLAYWRIGHT_BASE_URL="http://localhost:5000"
# Authenticated specs self-skip without SMOKE_TECH_USER/PASSWORD.
npm run test:e2e
```

## In CI

The `e2e` job in `.github/workflows/deploy.yml` runs after `smoke-test` against the just-deployed environment. It is **non-gating** (`continue-on-error: true`) — failures show in the job summary and upload `test-results/` + `playwright-report/` as artefacts, but don't roll back the deploy.

## Flake budget rules

- **One assertion per spec.** Two assertions → split into two specs.
- **Role-based or UI5-class selectors.** Never brittle CSS chains.
- **`retry: 2` in CI, `0` locally.** A spec that flakes twice in a week gets `it.skip` with a linked issue and a 7-day SLA.
- **No data mutation.** Read-only paths only — no INSERT/DELETE in these specs.

## Debugging failures

CI uploads `test-results/` and `playwright-report/` as workflow artefacts on failure (7-day retention).

Locally, run headed against a live deploy to watch the browser:

```bash
PLAYWRIGHT_BASE_URL="https://..." npx vitest run --project e2e test/e2e/admin-shell.test.js
```

## Do NOT commit

- `test-results/` — Playwright artefacts (gitignored)
- `playwright-report/` — HTML reports (gitignored)
- `.playwright-auth-state.json` — auth cookies (gitignored; not written today)

## Related

- Testing guide (all six Vitest projects): [`docs/developers/operations/testing-guide.md`](../../docs/developers/operations/testing-guide.md)
- Issue: [#1338](https://github.com/sap-tutorials/tutorials-ims/issues/1338) — admin-UI Playwright e2e smoke suite
- Design prior art: [`docs/superpowers/specs/2026-07-03-806-extend-testing-design.md`](../../docs/superpowers/specs/2026-07-03-806-extend-testing-design.md) (Thread 1, orphaned #806)
