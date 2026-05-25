---
title: Testing Guide
description: Vitest projects, hybrid write safety, layout, and how to run a single file.
---

# Testing Guide

> Source: extracted from project README, 2026-05-25.

Five Vitest projects defined in [vitest.config.ts](../../../vitest.config.ts) — each with its own include pattern, environment, and prerequisites:

| Project | Command | Backing store / target | Use |
| --- | --- | --- | --- |
| `unit` | `npm test` | In-memory SQLite (mock auth) | Default fast suite — pure-fn, parsers, CDS handlers, shared `srv/lib/` modules. Watch mode via `npm run test:watch` |
| `hybrid` | `npm run test:hybrid` | Real prod HDI via `cds bind --exec` | Schema deploy, HANA sequences, views, developer workflow, admin CRUD, search, vector round-trip, recommendations, audit/feedback. Requires `cf login` to DEV |
| `hybrid-qa` | `cds bind --exec -- npx vitest run --project hybrid-qa` | Real QA HDI (`hana-tutorials-db-qa`) | Author-channel parity tests; uses `pool: 'forks'` + `_guard.js` write protection |
| `smoke` | `npm run test:smoke` | Deployed approuter + srv over HTTP | Health, public endpoints, auth enforcement, OData metadata, content serve, search, WebSocket handshake, redirects, SEO/JSON-LD, QA routes. Set `SMOKE_BASE_URL` + `SMOKE_SRV_URL` |
| `a11y` | `npm run test:a11y` | Deployed approuter (Lighthouse CI) | WCAG smoke; full Lighthouse via `npm run test:a11y:lighthouse`, summary via `npm run test:a11y:summary` |

`npm run test:all` runs the full matrix under `cds bind --exec` (so hybrid + hybrid-qa get real bindings).

#### Hybrid write safety

`test/hybrid/_guard.js` (and the `hybrid-qa` setup file) check `ALLOW_HYBRID_WRITES=true` before any INSERT/UPDATE/DELETE. Test data is prefixed with `__TEST__` and removed in `afterAll`. The guard exists because hybrid suites hit the same DEV HDI that powers the deployed app — a leaked write is a real write.

#### Layout

- `test/unit/`, `test/lib/`, `test/jobs/`, `test/parsers/`, `test/integration/`, `test/srv-qa/` — picked up by `unit` (also pulls `srv/**/__tests__/`, `scripts/__tests__/`, and `app/analytics-explorer/src/**/__tests__/`)
- `test/hybrid/` — 17 hybrid suites
- `test/hybrid-qa/` — QA-channel parity
- `test/smoke/` — 26 smoke suites; CI runs them automatically after deploy via [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml)
- `test/a11y/` — Lighthouse CI config + summary script
- `test/fixtures/` — Shared fixture data (no test files)

#### Running a single file

```bash
npx vitest run test/lib/mail-client.test.js                 # one unit file
npx vitest run --project smoke test/smoke/health.test.js    # one smoke file
cds bind --exec -- npx vitest run test/hybrid/views.test.js # one hybrid file
```
