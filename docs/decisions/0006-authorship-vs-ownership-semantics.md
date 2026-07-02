---
title: 0006 — Authorship vs. ownership vs. contribution semantics
date: 2026-07-01
status: Accepted
deciders: (project team)
related:
  - "docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md"
  - "https://github.com/sap-tutorials/tutorials-ims/issues/862"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/872"
  - "https://github.com/sap-tutorials/tutorials-ims/pull/876"
---

# ADR 0006 — Authorship vs. ownership vs. contribution semantics

> **Status:** Accepted &nbsp;·&nbsp; **Date:** 2026-07-01 &nbsp;·&nbsp; **Deciders:** (project team)

## Context

A tutorial has four independent "who's associated with this?" signals accumulated across the platform's history:

| Priority | Source | Meaning |
|---|---|---|
| 1 | `Tutorials.author_ID = Users.ID` | Declared author, derived from frontmatter `authorProfile` at publish time |
| 2 | `TutorialContributors.user_ID` | Explicit contributor (co-author, editor) |
| 3 | `TutorialMeta.ownerEmail = Users.email` | Post-publish monitoring signal — who's responsible for keeping this current |
| 4 | Legacy `TutorialMeta.owner` free-text match | Migrated data from the legacy IMS's free-text owner column |

These four are surfaced via a `MyTutorialsRaw` UNION and a `MyTutorialsView` that computes `bestPriority = min(priority)` per (tutorial, user). The naming drift — "author," "owner," "contributor," "monitor," "watcher" — has caused two bugs in one week: PR #872 shipped `MyAuthoredTutorials` (priority-1 only) to the Sage VS Code extension, whose "My Tutorials" panel actually wants priority-3 semantics. Fixing that in #876/#878/#879 was purely a data-quality effort; it couldn't correct the wrong endpoint choice.

## Decision

**These four signals mean four different things. Each production consumer gets a purpose-built endpoint over `MyTutorialsView` scoped to the signal(s) it needs:**

| Signal | Endpoint | Consumer |
|---|---|---|
| Priority 1 — author FK | `GET /author/MyAuthoredTutorials` | Advocate object page `ownedTutorials` facet, admin Tutorial Health |
| Priority 3 — `TutorialMeta.ownerEmail` | `GET /author/MyOwnedTutorials` | Sage VS Code extension "My Tutorials" panel |
| Union of 1–4 | `GET /author/MyTutorials` | Legacy compat, ad-hoc admin queries |
| Priority 2 — contributor FK | *(no dedicated endpoint yet)* | YAGNI — filter `MyTutorials?$filter=bestPriority eq 2` on demand |

A signal's meaning is expressed in the *endpoint name* and the *comment block* at its projection site — never left to the client to figure out.

## Consequences

- **Positive.** Each Sage / admin / advocate consumer reads one URL and gets exactly the row set it should. No client-side filter discipline. Cache-friendly (fewer distinct query shapes). New readers can grep for the endpoint name and land on both the projection and the intent comment.
- **Positive.** A future fifth signal (e.g. `Repositories.owner`) fits the pattern: add priority 5 in `MyTutorialsRaw`, add a fifth endpoint when a client asks for it. No design decisions to re-litigate.
- **Negative.** Three endpoints instead of one. Every future change to the shape of `MyTutorialsView` has to preserve response-column parity across all three (unit tests guard this).
- **Neutral.** `bestPriority` remains on every response. Clients who need an "any-priority-under-N" filter can still do it via `$filter=bestPriority le N` on the broad endpoint — the endpoints are conveniences, not restrictions.
- **Neutral.** `TutorialMeta.ownerEmail` is only useful if it's clean. Data quality issues in that column (migration drift) surface immediately on `MyOwnedTutorials`; scrub scripts (like `scripts/scrub-tutorialmeta-owner-email.cjs`) become part of the operational discipline.

## Alternatives Considered

- **Overload `MyAuthoredTutorials` to mean priority ≤ 3 (author OR contributor OR owner).** Rejected — the name would misdescribe the row set, and the Advocate/admin consumers explicitly need priority-1-only. Adding "Authored" behavior to it would drop rows they depend on.
- **Single `MyTutorials` endpoint + `$filter=bestPriority eq N` for every consumer.** Rejected — puts filter discipline on every client, kills response caching (three consumers → three distinct URLs anyway), and Sage's earlier code demonstrated the "consumer forgets to filter" failure mode.
- **Encode the signal on the row as `ownershipSource: 'author' | 'contributor' | 'owner' | 'legacy'` instead of `bestPriority`.** Cleaner naming but equivalent in query power; deferred as a rename that would break every existing client without adding capability.

## References

- Originating spec: [docs/superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md](../superpowers/specs/2026-07-01-862-my-owned-tutorials-design.md)
- Related PRs: [#872](https://github.com/sap-tutorials/tutorials-ims/pull/872), [#876](https://github.com/sap-tutorials/tutorials-ims/pull/876), [#878](https://github.com/sap-tutorials/tutorials-ims/pull/878), [#879](https://github.com/sap-tutorials/tutorials-ims/pull/879)
- Code: [srv/author-service.cds](../../srv/author-service.cds), [db/views.cds](../../db/views.cds) — `MyTutorialsRaw` sources 1–4
- Design decisions aggregate: [docs/developers/reference/design-decisions.md](../developers/reference/design-decisions.md)
