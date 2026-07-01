---
title: NNNN — Short decision statement
date: YYYY-MM-DD
status: Proposed
deciders: (project team)
related: []
---

# ADR NNNN — Short decision statement

> **Status:** Proposed &nbsp;·&nbsp; **Date:** YYYY-MM-DD &nbsp;·&nbsp; **Deciders:** (project team)

## Context

What forced the decision — the problem, the constraints, the alternatives on the table when the discussion started. Keep it to what a reader who's never seen this subsystem needs to make sense of the rest of the record. Two or three paragraphs at most.

## Decision

State the choice in the active voice. One or two paragraphs. Be specific: "We store tutorial HTML as gzip-compressed BLOBs in HANA (`ContentFiles`), keyed by slug + manifest version," not "we chose HANA."

## Consequences

What follows — good and bad — from this choice.

- Positive: what this unlocks or simplifies.
- Negative: the ongoing cost (operational, cognitive, migration).
- Neutral: things a future maintainer needs to remember. Rules that only make sense in light of this decision live here.

## Alternatives Considered

For each: what it was, and why we didn't pick it. Keep to one or two sentences per alternative.

- **Alternative A** — one-line description. Rejected because …
- **Alternative B** — one-line description. Rejected because …

## References

- Originating spec: `docs/superpowers/specs/YYYY-MM-DD-…-design.md`
- Related issues / PRs: #NNN, #MMM
- Code entry points: `srv/…`, `db/…`, `hugo/…`
