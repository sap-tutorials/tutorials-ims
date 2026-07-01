---
title: 0003 — Public Hugo with lazy XSUAA login
date: 2026-04-22
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-04-22-tutorial-platform-poc-design.md"
  - "docs/developers/architecture/authentication.md"
---

# ADR 0003 — Public Hugo with lazy XSUAA login

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-04-22 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

The platform replaces AEM as the frontend for developers.sap.com. AEM served tutorial content anonymously — no OAuth bounce, no login wall — and any authentication-driven feature (progress ticks, points) was layered on afterward, opt-in per user. Preserving that user experience is a hard requirement: SEO depends on it, and reader friction is what the redesign is trying to reduce, not add.

The XSUAA-fronted AppRouter defaults to authenticated routes. If we accepted the default, every anonymous visitor would hit an IDP redirect on their first request. We needed a deliberate model for which routes are public, which are protected, and how a reader transitions from anonymous browsing to a signed-in session.

## Decision

The AppRouter's catch-all route `/*` (which covers Hugo static assets and rendered tutorial pages) is `authenticationType: "none"` — anyone can read tutorials without an OAuth bounce. Login is triggered **explicitly** when the user clicks the profile icon; the `/login` route is the only authenticated GET on a non-API path. API calls under `/api/*` enforce XSUAA at the router and return 401 to unauthenticated callers, which the client turns into a "sign in to save your progress" affordance — not a redirect.

Progress state for anonymous readers lives client-side (localStorage) and is migrated to the server on first login.

## Consequences

- **Positive.** Anonymous readers have zero login friction. SEO crawlers index tutorials without special-casing. The reader→signed-in transition is a single deliberate click, not a surprise redirect.
- **Positive.** The "backend never sees an anonymous request" invariant simplifies CAP: every request that reaches the srv either has a valid JWT or a documented public-route exception (see [ADR-0005](0005-bootstrap-vs-served-split.md) for how public endpoints register).
- **Negative.** Some UI features (Joule chat, progress ticks) have to render a "sign in" affordance for anonymous users where the naive design would just show the feature. The Hugo templates have anonymous-friendly fallbacks throughout.
- **Neutral.** Any new route added to `xs-app.json` needs an explicit auth decision — the default is "authenticated," and the reviewer must justify a `"none"` route. This is a recurring code-review discipline.

## Alternatives Considered

- **Authenticated-by-default with an anonymous fallback route.** Would have kept the AppRouter default and used a rewrite for anonymous access, but the reverse — public with explicit protection — matches how readers actually use the site. Rejected.
- **Client-side auth (SPA + backend token).** Would have simplified the router config, but XSUAA + AppRouter is the SAP-standard pattern and the rest of the BTP tooling assumes it. Rejected.
- **Cookie-based session with lazy JWT exchange.** Would have avoided the redirect entirely, but is not how XSUAA is designed to be used and would have precluded reuse of the shared IMS XSUAA instance. Rejected.

## References

- Originating spec: [docs/superpowers/specs/2026-04-22-tutorial-platform-poc-design.md](../superpowers/specs/2026-04-22-tutorial-platform-poc-design.md)
- Architecture: [docs/developers/architecture/authentication.md](../developers/architecture/authentication.md)
- Config: [approuter/xs-app.json](../../approuter/xs-app.json)
