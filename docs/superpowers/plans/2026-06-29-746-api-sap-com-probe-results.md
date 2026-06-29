# api.sap.com discovery probe — results

**Date:** 2026-06-29
**Phase:** 4.5 Task 1 Step 1 (per `2026-06-29-746-phase4.5-task1-chassis.md`)
**Outcome:** **PROBE_FAILURE** — proceed with the YAML-only branch (§1.2-B).

## What was probed

9 candidate endpoints, all unauthenticated, all timed out at 15s:

| # | URL | HTTP | Body | Conclusion |
|---|---|---|---|---|
| 1 | `https://api.sap.com/odata/1.0/catalog.svc/Packages?$format=json&$top=3` | 200 | 679 B | SPA bootstrap (login-redirect HTML) |
| 2 | `https://api.sap.com/api/sitemap.xml` | 200 | 679 B | SPA bootstrap |
| 3 | `https://api.sap.com/shell/discover/external/contenthub/data/categories/...` | 200 | 683 B | SPA bootstrap |
| 4 | `https://api.sap.com/searchsupport/api/odata.svc/` | 200 | 681 B | SPA bootstrap |
| 5 | `https://api.sap.com/shell/discover/external/contenthub/data/` | 200 | 681 B | SPA bootstrap |
| 6 | `https://api.sap.com/odata/1.0/catalog.svc/Packages?$format=json` (Accept: application/json) | 200 | 681 B | SPA bootstrap |
| 7 | `https://api.sap.com/business-accelerator-hub/api/0.1/v1/contenthub-data/api-packages?page_size=3` | 200 | 683 B | SPA bootstrap |
| 8 | `https://api.sap.com/business-accelerator-hub/api/0.1/v1/search?q=cap&page_size=3` | 200 | 679 B | SPA bootstrap |
| 9 | `https://api.sap.com/search-engine/api/0.1/v1/search?searchString=cap` | 200 | 679 B | SPA bootstrap |

Every candidate returns the same SPA bootstrap HTML (~680 bytes) — the page sets a `fragmentAfterLogin`/`locationAfterLogin` cookie pair and redirects to the SAP IDP login flow. The actual data API (whatever the browser app hits after authentication) is gated behind the SAP UA login flow with cookie-jar state.

## sap-devs MCP fallback also failed

`mcp__sap-devs-server__search_resources` for `"api.sap.com"` returned **0 results**. The MCP indexes cap.cloud.sap docs, GitHub sample repos, and community pages — not api.sap.com URLs.

## Implication

Phase 4.5 ships the **YAML-only branch (§1.2-B)** of Task 1. The corpus fetcher (`srv/lib/api-sap-com-fetcher.js`) is implemented as YAML-only with an HTTP `_setMockFetcher` stub seam preserved. A future re-probe (e.g. if SAP opens up an unauthenticated catalog endpoint) can retrofit HTTP mode without rewriting the cron's contract.

Acceptance criterion #4 from spec §9 reduces to: **"cron extends links only, not corpus."** This is the spec's pre-approved degraded shipping path per §7.4.

## Operator implications

- Catalog growth is 100% manual: edit `db/data/api-docs.yaml` → PR → merge → redeploy → run `scripts/seed-api-docs.cjs --commit` (or click the admin UI button).
- The monthly cron still runs and is still useful — it re-extracts concept links on each cycle, so new `Concepts` rows that appear between cycles get linked into existing api-docs the next time around.
- TTL chassis edit (3650 → 1095) is unchanged — catalog drift detection still applies if SAP ever removes a hand-curated entry.
