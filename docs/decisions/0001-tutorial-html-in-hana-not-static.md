---
title: 0001 — Tutorial HTML persists in HANA, not on disk
date: 2026-04-28
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-04-28-hugo-migration-design.md"
  - "docs/developers/reference/design-decisions.md"
---

# ADR 0001 — Tutorial HTML persists in HANA, not on disk

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-04-28 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

Hugo builds ~1400 tutorial pages in seconds. The naive deployment is to ship every generated `hugo/public/tutorials/*/index.html` as static content inside the AppRouter. That's what the AEM predecessor and every prior static-site iteration did.

Two problems pushed us off that path. First, the corpus is ~1400 tutorials, some multi-megabyte after images; bundling them into the approuter MTA module inflates the deploy tarball and every push. Second, the platform needs to hot-fix a single tutorial — a broken screenshot, a code-sample typo — without redeploying the approuter and cycling XSUAA sessions. A one-tutorial fix should be a database write, not a Cloud Foundry deploy.

## Decision

Tutorial HTML is stored as gzip-compressed BLOBs in HANA under `ContentFiles`, versioned via `ContentManifest`. After Hugo builds, [scripts/publish-content.ts](../../scripts/publish-content.ts) computes a SHA-256 per slug, diffs against the server's `/content/hashes`, and uploads only the changed slugs through the chunked `POST /content/publish` protocol. The AppRouter rewrites `/tutorials/{slug}` → `/content/tutorials/{slug}` on the srv, which decompresses and serves the HTML with ETag headers and a bounded LRU cache (50 MB). `approuter/static/tutorials/` is explicitly removed at build time.

## Consequences

- **Positive.** A single-tutorial hotfix is a `gh workflow run rebuild-content.yml -f slug=…` (~2 min wall-clock) instead of a full MTA deploy (~10 min). The approuter tarball stays small. Rollback is a manifest pointer flip, not a re-push. Versioned manifests give us `/content/rollback` for free.
- **Negative.** No static fallback: if nothing has been published to HANA, `/tutorials/*` returns 404. HANA-specific quirks propagate to the read path — see ADR-0005 on `bootstrap`/`served` and the "never SELECT a BLOB alongside metadata" rule in [srv/lib/content-store.js](../../srv/lib/content-store.js) (HANA LOB locators expire when mixed with non-BLOB columns).
- **Neutral.** The manifest model requires a daily garbage-collection cron (03:00) that prunes `SUPERSEDED`/`ROLLED_BACK` versions older than 7 days, keeping the 3 most recent for rollback. `ACTIVE` and `PUBLISHING` are never touched. This is a scheduled job the platform owns forever.
- **Neutral.** The publish path must be idempotent under retry — the chunked `begin → append → commit` protocol carries forward unchanged slugs on the server side, so a delta payload cannot silently drop the rest of the catalog.

## Alternatives Considered

- **Bundle HTML in the approuter MTA module.** Simplest to reason about, but conflates content updates with code deploys and inflates every push. Rejected on operational grounds — the one-tutorial hotfix requirement is non-negotiable.
- **Object Store (S3-style) with signed URLs.** Removes the deploy coupling but adds a second infrastructure dependency the platform doesn't otherwise use, and the auth/routing gets awkward once we want ETag + Cache-Control uniform with the rest of the CAP surface. Rejected because HANA is already there for progress data.
- **Filesystem-backed cache on the srv container.** Storage isn't durable across Cloud Foundry restarts, and the cache would need to be re-warmed from GitHub on every restart, coupling srv availability to GitHub availability.

## References

- Originating spec: [docs/superpowers/specs/2026-04-28-hugo-migration-design.md](../superpowers/specs/2026-04-28-hugo-migration-design.md)
- Design decisions aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md) §Architecture
- Code: [srv/lib/content-store.js](../../srv/lib/content-store.js), [srv/lib/content-publish-session.js](../../srv/lib/content-publish-session.js), [scripts/publish-content.ts](../../scripts/publish-content.ts)
- Runbook: [docs/developers/operations/rebuild-content-workflow.md](../developers/operations/rebuild-content-workflow.md)
