---
title: 0004 — JWT-only identity on CAP (no SCI profile enrichment)
date: 2026-04-28
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-04-28-ims-cap-rewrite-design.md"
  - "docs/developers/architecture/authentication.md"
---

# ADR 0004 — JWT-only identity on CAP (no SCI profile enrichment)

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-04-28 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

The Java IMS predecessor resolved user identity by taking the XSUAA JWT's subject, then making a synchronous HTTP call to SAP Cloud Identity (SCI) `/cps/*` endpoints to enrich the profile with display name, email verification state, and role attributes. This gave rich per-request user data at the cost of one out-of-band SCI hop on every authenticated request — plus a hard runtime dependency on SCI availability, and rate limits when the platform's request volume grew.

The CAP rewrite had a fork in the road: keep the SCI enrichment (behaviour parity) or move identity resolution entirely to what's already on the JWT.

## Decision

User identity on the CAP srv comes exclusively from the XSUAA JWT — specifically `xs.user.attributes` and the standard claim set. No synchronous SCI lookup happens on the request path. Profile enrichment (display name, avatar, verified state) uses whatever the IDP put on the token; where richer data is needed (e.g. bulk backfill), we do it asynchronously outside the request cycle.

## Consequences

- **Positive.** No SCI latency in the request path. No cascade failure when SCI is rate-limiting or degraded. The srv can be reasoned about as a pure JWT consumer: given a valid token, identity is fully determined without another network hop.
- **Positive.** Simpler local dev — a hybrid session with `cds bind` doesn't need SCI credentials, only an XSUAA binding.
- **Negative.** The token has to carry everything we need. When we discovered author-nudge emails were unbound after migration ([memory: project_ims_author_nudge_emails_unbound]), the fix couldn't be "just call SCI"; it needed a proper async backfill path and a lazy self-heal on next login. We accept that cost.
- **Neutral.** Any feature that reads a user attribute not on the JWT is a design pause: either the IDP mapping needs to include the attribute, or the feature has to work with what's there. This forces a healthy conservatism about profile scope.
- **Neutral.** SCI rate limits observed at ~10 concurrent lookups (see memory `feedback_sci_cps_endpoint_rate_limits_aggressively`) confirmed the wisdom of keeping SCI off the request path even for async paths.

## Alternatives Considered

- **Keep SCI enrichment (parity with Java IMS).** Rejected because the reliability and latency cost was material and the CAP rewrite was the moment to reset it.
- **Cache SCI lookups per-user in HANA with TTL.** Considered as a hybrid. Rejected as an unnecessary layer once we accepted that everything we actually need is already on the token — the cache would exist to defend a hop we no longer take.
- **Full profile snapshot on first login, updated by a webhook.** Cleaner than caching but requires SCI to reliably deliver webhooks and requires ongoing sync logic. Deferred — may return as an option if attribute needs grow.

## References

- Originating spec: [docs/superpowers/specs/2026-04-28-ims-cap-rewrite-design.md](../superpowers/specs/2026-04-28-ims-cap-rewrite-design.md)
- Architecture: [docs/developers/architecture/authentication.md](../developers/architecture/authentication.md)
- Related decision aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md) §Data + identity
