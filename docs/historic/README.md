---
title: Historic — Decommissioned Context
description: AEM, Java IMS, and completed-migration documentation kept for historical reference. Does not reflect the running system.
---

# Historic — Decommissioned Context

This folder holds documentation that no longer reflects the running system but matters for understanding why current code looks the way it does. Read these files when investigating legacy decisions, debugging migrated data, or onboarding to areas that still carry historical baggage.

> **Not a runbook.** None of these files describe how the platform works today. For the current system, start at [docs/README.md](../README.md) and pick a persona.

## AEM era

Adobe Experience Manager hosted developers.sap.com tutorials before the cutover to this platform.

- [aem-current-state.md](aem-current-state.md) — snapshot of how AEM served developers.sap.com at decommission time
- [aem-gap-analysis.md](aem-gap-analysis.md) — functional gaps between AEM and the current platform

## IMS era

The Information Management System was the Java/Spring Boot backend that tracked tutorial progress before the CAP rewrite.

- [ims-api-reference.md](ims-api-reference.md) — IMS REST API surface
- [ims-uncovered-features.md](ims-uncovered-features.md) — IMS capabilities not yet replicated in the current platform
- [data-migration.md](data-migration.md) — cutover-era data migration scripts and procedures

## Completed migrations

Writeups of platform-level migrations that are now finished. Useful when the resulting code reads strangely without context.

- [hugo-migration.md](hugo-migration.md) — VitePress → Hugo migration
- [vitepress-2x-upgrade-assessment.md](vitepress-2x-upgrade-assessment.md) — assessment of upgrading the legacy `site/.vitepress/` install (note: not about the planned future docs-site VitePress, which is a separate concern)
- [github-app-migration.md](github-app-migration.md) — PAT → GitHub App auth migration writeup

## Task-level mapping

[decommissioned-tasks.md](decommissioned-tasks.md) — maps every task from the legacy meta-tutorials run-book to its replacement (or marks it as no longer applicable).
