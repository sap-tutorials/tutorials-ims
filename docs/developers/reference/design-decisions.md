---
title: Key Design Decisions
description: Architectural, CAP runtime, data/identity, and operational decisions worth knowing before changing core code paths.
---

# Key Design Decisions

> Source: extracted from project README, 2026-05-25.

#### Architecture

- **Tutorial HTML lives in HANA, not on disk.** Hugo builds HTML, `publish-content.ts` gzip-compresses + SHA-256-hashes per slug, then uploads only the changed slugs as BLOBs to `ContentFiles` + `ContentManifest`. AppRouter rewrites `/tutorials/{slug}` → `/content/tutorials/{slug}` on the srv, which decompresses and serves with ETag + bounded LRU. Consequence: `approuter/static/tutorials/` is explicitly removed during build — there is no static fallback. If nothing has been published, `/tutorials/*` returns 404.
- **QA channel is a parallel srv + HDI, not just a route flag.** `tutorials-srv-qa` binds to `tutorials-hana-qa`, runs the same handlers, and exposes preview content gated by the `Tutorial.Author` XSUAA scope. The router sends `/tutorials-qa/*` to the QA destination. Authors get prod-shaped previews with zero risk of cross-tenant data leakage; prod queries can never accidentally hit QA tables.
- **Public Hugo + lazy login.** The catch-all `/*` is `authenticationType: "none"` — anyone can read tutorials without an OAuth bounce. Login is triggered explicitly when the user clicks the profile icon (the `/login` route is the only authenticated GET on a non-API path). API calls under `/api/*` enforce XSUAA at the router and return 401 if the user hasn't signed in yet.
- **Optional service bindings degrade gracefully.** `tutorials-audit-log`, `tutorials-cloud-logging`, and `tutorials-aicore` are `optional: true` in the MTA. The srv detects missing bindings at boot: chat returns 503, audit logging falls through to the console sink, OTLP export is no-op. This makes `mbt build && cf deploy` succeed in fresh sandbox subaccounts that haven't been entitled to AI Core.
- **4-tier GitHub discovery resilience.** Live GitHub → on-disk cache → `RepoCatalog` baseline (HANA) → degrade. CI is the canonical writer of `RepoCatalog` — author pushes update the baseline so a GitHub outage at build time doesn't break the build.

#### CAP runtime

- **`bootstrap` vs. `served` event split.** Custom Express routes (`/api/qrcode`, `/build/*`, `/feedback/*`, `/content/*`, `/auth/user`, `/health`, `/chat/stream`) register on `bootstrap` — before CDS auth middleware — so unauthenticated routes can opt out cleanly. Jobs and the Socket.IO plugin register on `served`, after entities and services exist.
- **Socket.IO via `@cap-js-community/websocket`, not raw WebSocket.** `@protocol: ['websocket', ...]` annotations on `DisplayService` + `EventStreamService` map CDS events to Socket.IO messages on `/ws/display` and `/ws/event-stream` namespaces. Scope check happens at namespace-join time (the router can't enforce XSUAA on a Socket.IO upgrade without breaking the handshake).
- **Never SELECT a HANA BLOB alongside metadata in one CDS QL query.** The LOB locator expires before the stream is consumed when mixed with non-BLOB columns. `srv/lib/content-store.js` and `srv/lib/embedding-query.js` use raw `db.run()` SQL on HANA and CDS QL on SQLite (unit tests). This is a HANA-only quirk that SQLite silently tolerates.
- **`AnalyticsService.runSelectQuery` is gated by allowlist + parser, not just `@requires`.** `srv/lib/analytics-sql-validator.cjs` rejects anything that isn't a single `SELECT` against the `@analytics.exposed` table set, then wraps with `LIMIT 5001` so a runaway query can't OOM the srv. The exposed entity surface for the `AnalyticsService` is governed by the same `@analytics.exposed` annotations on CDS views.

#### Data + identity

- **JWT-only identity on CAP** (vs. the Java IMS's SCI lookup). User attributes come from `xs.user.attributes` on the XSUAA JWT — no synchronous network hop for profile enrichment. See [docs/developers/architecture/authentication.md](../architecture/authentication.md).
- **`@PersonalData` + `@cap-js/audit-logging`** drives audit events on `Users`/`UserMetaData`/`TaskRecords` automatically. Plus a manual `SecurityEvent` on user anonymization. No hand-written audit calls.
- **`@changelog` + `@cap-js/change-tracking`** on admin-managed entities (Events, Missions, Groups, Accomplishments, Prizes, ImsConfig, FeaturedTasks, ChatSettings) for the changelog UI.
- **Legacy ID sequences (HANA `.hdbsequence`)** on every entity that exposes an integer ID to legacy IMS consumers. Used during parallel operation; remains a public contract until the cutover deprecation window closes.
- **Slug fields are required** for `Missions.slug` and `CompletionPaths.slug`, populated by `scripts/setup-dev-data.cjs` from `.migration-data/slug-mapping.json` after a fresh DB deploy. Without slugs, `/build/catalog` returns numeric IDs and Hugo cannot generate mission/group URLs.

#### Operational defaults

- **`publish-content` always runs with `--force` in production.** Default delta detection silently drops slugs from the manifest because the server treats every publish as a full snapshot — `--force` bypasses delta and republishes the full set. (See [memory: publish-content needs --force](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_publish_content_force.md).)
- **Daily content GC** at 03:00 prunes `SUPERSEDED`/`ROLLED_BACK` content versions older than 7 days (keeps 3 most recent for rollback). Never touches `ACTIVE` or `PUBLISHING`.
- **Notification toggle gates the scheduled job only.** The manual `sendContributorNotifications` admin action always sends regardless — operators need to be able to recover from a misconfigured cron without disabling and re-enabling the toggle.
- **`FailedEmails` + `NGDSFailedMessages` retry queues** keep the integration paths idempotent. Transport failures are persisted, not raised, so a missing SMTP in dev is graceful, not fatal. Retry job replays with exponential backoff.
