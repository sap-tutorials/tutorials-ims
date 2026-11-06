---
name: event-app-space-report
description: >-
  Use when asked for completion statistics / a report for an SAP event (TechEd,
  ASUG Tech Connect, DSAG, etc.) on the tutorials-ims / developers.sap.com
  platform, given an app-space URL (…/app-space/?eventId=NNN) or a bare eventId.
  Produces the four-section report: tutorial completions by Track, abandonment +
  step-drop histogram, completer email-domain breakdown, and SAP-vs-external.
  Triggers on "report/statistics from the event <url|eventId>", "app-space stats
  for …", "event completion numbers".
---

# Event App-Space Report

Produces a point-in-time, read-only completion report for one event, scoped by
the event's **date window** to the tutorials linked via its mission's
CompletionPaths (Tracks). Reuses the server helper `srv/lib/event-path-buckets.js`
so Track numbers match the live app-space page.

## Input

An app-space URL (`https://developers.sap.com/app-space/?eventId=10000003&theme=…`)
or a bare `eventId` (= `Events.legacyId`). The script parses either.

## Steps

1. **Parse the eventId** from the URL (or accept the bare id).
2. **Target PROD.** The report runs against PROD HANA. Confirm you are logged in
   and targeted at the **prod** space first:
   ```bash
   cf target        # org/space must be prod
   cf target -s prod
   ```
   The script enforces this (`assertCfTargetProd`) and refuses to run on any
   other space — it is the only env-separation safeguard (binding follows the
   current `cf` login; there is no prod-vs-dev named binding).
3. **Bind PROD HANA** if not already bound in this worktree:
   ```bash
   cds bind -2 tutorials-hana
   ```
   **Do NOT use the `tutorials-hana:tutorials-hana-key` service-key** — per
   `docs/developers/operations/gameboard-prod-data-troubleshooting.md` it maps to
   a near-empty decoy HDI container, not the live app container. Use the plain
   instance binding.
4. **Run the report** (read-only; SELECT/CQL only, no writes):
   ```bash
   cds bind --exec -- node scripts/event-report.mjs <eventId> [--json]
   ```
   `--json` additionally prints the raw event + bucket aggregates.
5. **Present** the emitted markdown to the user (the four sections).

## Verification

Cross-check the **Track** totals against the live app-space page or the admin
`getEventBuckets` OData call for that event when the user wants assurance. The
script reuses the same `computePathBuckets` helper, so a mismatch means a
binding/environment problem (wrong space, decoy container), not a logic
difference.

## Report sections

1. **Tutorial completions by track** — total + per-Track count and share
   (`CompletionPaths.name`; FK-first tutorial resolution; windowed COMPLETED/
   SUPERSEDED completions).
2. **Abandoned tutorials** — IN_PROGRESS tutorials whose record was last touched
   (`modifiedAt`) inside the window, with per-tutorial median stop-step and a
   per-step drop histogram (stop-step = COMPLETED STEP records at the user's
   current attempt vs `Tutorials.stepCount`).
3. **Completer email domains** — distinct completers per domain, completions,
   and completions/user; most-engaged domains.
4. **SAP employees vs external** — `@sap.com` vs everyone else.

## Notes

- Read-only and prod-guarded. No writes, no deploy.
- `scripts/event-report.mjs` lives in the main repo, so it's runnable outside
  this skill too (`cds bind --exec -- node scripts/event-report.mjs <eventId>`).
- Scoping is by **date window**, never `TaskRecords.event_ID` (NULL on normal
  completions). Track = `CompletionPaths.name`, not Mission title.
