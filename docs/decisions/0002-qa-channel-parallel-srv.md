---
title: 0002 — QA channel is a parallel srv + HDI, not a route flag
date: 2026-05-23
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-05-23-tutorials-qa-endpoint-design.md"
  - "docs/developers/operations/qa-channel-bootstrap.md"
---

# ADR 0002 — QA channel is a parallel srv + HDI, not a route flag

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-05-23 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

Tutorial authors write content in `*-Contribution` GitHub repositories before it lands in the public-facing main repos. They need a production-shaped preview surface — same Hugo layouts, same search behaviour, same auth boundary — sourced from the unmerged `-Contribution` content. The existing true-Dev environment doesn't help: it also serves prod content from the main repos.

The obvious lightweight approach is a single srv that answers both `/tutorials/*` and `/tutorials-qa/*` from the same HDI container, with a `channel` column on `ContentFiles`. The obvious problem is blast radius: a misconfigured QA build, a malformed tutorial, or a stuck publish must not affect production tables, jobs, or response paths — and prod queries must never accidentally read from QA rows.

## Decision

QA is a **parallel srv + HDI**, not a channel column. `tutorials-srv-qa` binds to `tutorials-hana-qa` and runs the same handlers as prod; it exposes only preview content gated by the `Tutorial.Author` XSUAA scope. The AppRouter routes `/tutorials-qa/*` to the QA destination. The QA CAP project reuses the same CDS sources for duplicated entities via `using` imports, but deploys them into a physically separate HDI container. QA does not expose Joule, RAG, `Users`/`TaskRecords`, audit logging, or the admin UI.

## Consequences

- **Positive.** Prod queries can never accidentally hit QA tables, and a broken QA deploy cannot brick prod. Author previews are prod-shaped with zero cross-tenant leakage risk. The parallel structure also means we can iterate on the srv layer (e.g. try a new content-serve endpoint) on QA without touching prod.
- **Negative.** Every srv-layer refactor has to consider both paths. The `srv-qa/` module has a hand-curated `cp` list in `.deploy/mta.yaml` for transitive imports from `srv/lib/`; missing a new transitive dep here silently crashes QA boot. This is a recurring maintenance tax and has bitten us multiple times (see the "check srv-qa when changing srv" gotcha).
- **Neutral.** QA fetch runs with `ONLY_CONTRIBUTION_REPOS=true`; the cache lives at `.tutorial-cache-qa/`; Hugo builds with a sibling `hugo.qa.toml` that strips the interactive UI (Joule FAB, rating, completion buttons). The `CONTENT_API_KEY_QA` secret is separate from prod. All of this is required and cannot be collapsed without collapsing the isolation.

## Alternatives Considered

- **Single srv with a `channel` column on `ContentFiles`.** Simplest, but the whole point is data-plane isolation. Any bug in a channel-aware WHERE clause becomes a cross-tenant leak. Rejected.
- **A separate BTP subaccount for QA.** Total isolation, but authors need to log in with the same identity they use for prod; splitting the subaccount forces a second XSUAA and a second IDP mapping. Deferred as overkill for author-preview traffic.
- **Reuse the existing DEV environment.** DEV already serves main-repo content and is the platform team's integration surface; giving authors access there would collide with our own iteration loop. Rejected.

## References

- Originating spec: [docs/superpowers/specs/2026-05-23-tutorials-qa-endpoint-design.md](../superpowers/specs/2026-05-23-tutorials-qa-endpoint-design.md)
- Runbook: [docs/developers/operations/qa-channel-bootstrap.md](../developers/operations/qa-channel-bootstrap.md)
- Related workflow: [.github/workflows/rebuild-content-qa.yml](../../.github/workflows/rebuild-content-qa.yml)
- MTA definition: [.deploy/mta.yaml](../../.deploy/mta.yaml) — `srv-qa`, `db-qa` modules
