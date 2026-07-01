---
title: 0005 — bootstrap vs. served route/plugin split
date: 2026-04-28
status: Accepted
deciders: (project team)
related:
  - "docs/developers/reference/design-decisions.md"
  - "docs/developers/architecture/cap-backend.md"
---

# ADR 0005 — `bootstrap` vs. `served` route/plugin split

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-04-28 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

The CAP srv has three categories of things to wire up on startup:

1. Custom Express routes that must be unauthenticated (`/api/qrcode`, `/build/*`, `/feedback/*`, `/content/*`, `/auth/user`, `/health`, `/chat/stream`).
2. Custom Express routes that must be authenticated (or use their own bearer-token auth, e.g. `POST /content/publish`).
3. Scheduled jobs and the Socket.IO plugin, which need entities and services to exist before they attach.

CAP fires two boot events: `cds.on('bootstrap')` runs before the CDS auth middleware is installed, and `cds.on('served')` runs after all entities and services are constructed. Getting the wiring order wrong causes subtle bugs — an unauthenticated route registered on `served` gets 401s from the auth middleware; a job attached on `bootstrap` finds no services to hook.

## Decision

- Custom Express routes register on **`cds.on('bootstrap')`** — before CDS auth middleware. Individual routes opt in to auth by mounting their own middleware; the default is anonymous. This is where public endpoints declare themselves.
- Scheduled jobs and the Socket.IO plugin register on **`cds.on('served')`** — after entities and services exist. The `@cap-js-community/websocket` plugin also self-mounts on `served`, independently.

The split is documented at the top of [srv/server.js](../../srv/server.js) and any new route or job must slot into the correct event.

## Consequences

- **Positive.** Public endpoints can cleanly opt out of the CDS auth middleware without exceptions in the middleware itself. The auth boundary is explicit: everything under a CDS service is authenticated by default; everything mounted on `bootstrap` is anonymous by default.
- **Positive.** Jobs start against a fully-constructed service graph — no race where a scheduler fires before its target service exists.
- **Negative.** New contributors have to learn the split. Getting it wrong is silent-ish: the request works in the wrong way (returns 401 when it shouldn't, or the job fails to attach with a stack trace at boot). Documented in [architecture/cap-backend.md](../developers/architecture/cap-backend.md).
- **Neutral.** WebSocket namespaces cannot enforce XSUAA at the AppRouter layer without breaking the Socket.IO upgrade handshake, so scope checks (e.g. `DisplayApp`) run at namespace-join time inside the srv. This is a direct consequence of the `served`-time plugin attachment and is called out in the WebSocket handlers.
- **Neutral.** Any custom route that needs auth must import and mount CDS's auth middleware explicitly, or use a bearer-token check (as `/content/publish` does with `CONTENT_API_KEY`).

## Alternatives Considered

- **Register everything on `served`.** Would have unified the wiring, but every public endpoint would have needed a bypass hack in the auth middleware. The middleware would then be the single point of exception, which is much harder to reason about than one-off explicit anonymous routes.
- **A separate anonymous sub-app mounted outside the CDS auth middleware.** Cleaner in theory, but two Express apps living in one process complicates request logging, error handling, and middleware sharing. Deferred; the current split is simpler.

## References

- Design decisions aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md) §CAP runtime
- Architecture: [docs/developers/architecture/cap-backend.md](../developers/architecture/cap-backend.md)
- Code: [srv/server.js](../../srv/server.js)
- WebSocket plugin: [@cap-js-community/websocket](https://github.com/cap-js-community/websocket)
