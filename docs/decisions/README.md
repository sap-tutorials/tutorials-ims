# Architecture Decision Records

Canonical, single-topic records for the architectural decisions that shape this platform. Each ADR captures one decision with enough context that a future maintainer can tell **why** we chose what we chose — and what they'd have to redo if they wanted to change it.

## What lives here vs. elsewhere

- **ADRs (`docs/decisions/`)** — one decision per file, with a life-cycle status (Proposed / Accepted / Superseded / Deprecated). Short, self-contained, cross-linked to the originating spec or PR.
- **Design specs (`docs/superpowers/specs/YYYY-MM-DD-*.md`)** — narrative design documents for a feature or subsystem. May contain several decisions bundled together with implementation detail. **Specs are the source of truth for the narrative; ADRs are the source of truth for the decision.**
- **Design decisions aggregate ([../developers/reference/design-decisions.md](../developers/reference/design-decisions.md))** — a fast-scan one-liner list of every architectural rule of the platform. Read this to orient; drop into an ADR when you need the *why*.

If a decision is worth its own follow-up conversation a year from now, write an ADR. If it's a tactical choice tied to one feature's implementation, keep it in the spec.

## Filename convention

`NNNN-kebab-case-title.md` — four-digit, zero-padded, monotonically increasing. Numbers are permanent; if an ADR is superseded, the new ADR gets the next number and the old one is marked `Superseded by ADR-NNNN`.

Never renumber; never delete. Deprecated ADRs stay, so the trail is intact.

## Status vocabulary

| Status | Meaning |
|---|---|
| `Proposed` | Drafted, under review. Not yet in effect. |
| `Accepted` | The decision the platform runs under today. |
| `Superseded by ADR-NNNN` | Replaced by a later ADR. Kept for history. |
| `Deprecated` | No longer applies, but not replaced by a newer ADR (e.g. the constraint the decision addressed went away). |

## Writing a new ADR

1. Copy [`_template.md`](_template.md) to `NNNN-your-title.md` with the next unused number.
2. Fill it in. Keep the whole document under ~120 lines — one screenful of context beats an unread essay.
3. Add an entry to the table below.
4. Add the ADR to the sidebar in `docs/.vitepress/config.ts` under **Developers → Reference → Architecture decisions (ADR)**. The `predocs:build` guard fails the build if you skip this.
5. Open a PR. ADRs are reviewed like code.

## Index

| # | Title | Status | Date | Related |
|---|---|---|---|---|
| [0001](0001-tutorial-html-in-hana-not-static.md) | Tutorial HTML persists in HANA, not on disk | Accepted | 2026-04-28 | [hugo-migration spec](../superpowers/specs/2026-04-28-hugo-migration-design.md) |
| [0002](0002-qa-channel-parallel-srv.md) | QA channel is a parallel srv + HDI, not a route flag | Accepted | 2026-05-23 | [tutorials-qa spec](../superpowers/specs/2026-05-23-tutorials-qa-endpoint-design.md) |
| [0003](0003-public-hugo-lazy-login.md) | Public Hugo with lazy XSUAA login | Accepted | 2026-04-22 | [POC spec](../superpowers/specs/2026-04-22-tutorial-platform-poc-design.md) |
| [0004](0004-jwt-only-identity.md) | JWT-only identity on CAP (no SCI profile enrichment) | Accepted | 2026-04-28 | [IMS CAP rewrite spec](../superpowers/specs/2026-04-28-ims-cap-rewrite-design.md), [authentication](../developers/architecture/authentication.md) |
| [0005](0005-bootstrap-vs-served-split.md) | `bootstrap` vs. `served` route/plugin split | Accepted | 2026-04-28 | [design-decisions §CAP runtime](../developers/reference/design-decisions.md) |

## See also

- [Design decisions](../developers/reference/design-decisions.md) — quick-scan list of every architectural rule the platform runs under
- [Postmortems](../postmortems/README.md) — sibling directory: what went wrong, what we changed
- Design specs — dated design documents (`docs/superpowers/specs/`, browsable in the repo; excluded from the VitePress build)
