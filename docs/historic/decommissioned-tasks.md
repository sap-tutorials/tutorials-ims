# Decommissioned Tasks

This document maps tasks from the historical `meta-tutorials` run-book that no longer apply to the new system to their replacement (or notes that the task is gone). It exists so people who knew the old workflows can find the new home.

This folder (`docs/historic/`) is intended to grow as other historical documents from the AEM/IMS era are consolidated. As of 2026-05-25, this is the only file.

## AEM-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| Update Developer Center Home Page (AEM Quick Publish, weekly) | Removed | The landing page is now built by Hugo from `tutorials-ims` and deploys automatically on merge — no manual publish step. |
| Check AEM Tutorial Pipeline / Tutorial Import Admintool | Replaced | [GitHub Actions `rebuild-content.yml`](../../.github/workflows/rebuild-content.yml) plus the admin UI Pipeline Logs — see [center-admin.md § Monitor the publish pipeline](../authors/center-admin.md#task-monitor-the-publish-pipeline). |
| AEM Log Harvester (`bin/systemReport.this.html`) | Replaced | Cloud Foundry logs via the admin UI's `cfLogsUrl` link, or `cf logs <app>` directly. |
| Import a New Tag from AEM/Semaphore (AEM Tutorial Import plugin / `gitHubAdmin.html`) | Replaced | Admin UI Tags app at `/admin-ui/tags` — see [center-admin.md § Import a new tag from the SAP taxonomy](../authors/center-admin.md#task-import-a-new-tag-from-the-sap-taxonomy). |
| Add a New Group (AEM `Tools > Developers > Group Admin` paired with IMS Groups) | Replaced | Admin UI Groups app at `/admin-ui/groups` — see [center-admin.md § Add / revise / delete a Group](../authors/center-admin.md#task-add--revise--delete-a-group). |
| Revise / Delete a Group (AEM Group Admin) | Replaced | Same — Admin UI Groups app. See [center-admin.md § Add / revise / delete a Group](../authors/center-admin.md#task-add--revise--delete-a-group). |
| Add / Revise / Delete a Mission (AEM + IMS) | Replaced | Admin UI Missions app at `/admin-ui/missions` — see [center-admin.md § Add / revise / delete a Mission](../authors/center-admin.md#task-add--revise--delete-a-mission). |
| Retiring a Tutorial (AEM redirect tree under `/etc/redirect`) | Replaced | Admin UI Operations app — see [center-admin.md § Retire a tutorial (admin side)](../authors/center-admin.md#task-retire-a-tutorial-admin-side). |
| AEM author access (QA-Blue / Production) | Removed | No AEM in the new stack. The author preview is the QA channel — see [qa-channel-bootstrap.md](../developers/operations/qa-channel-bootstrap.md). |
| Monitor and Publish Trials and Downloads updates (DSRT-driven AEM workflow) | Removed | Trials and Downloads are no longer published through the tutorials pipeline. |

## IMS-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| IMS Production Backup | Replaced | HANA Cloud automated backups via BTP cockpit (point-in-time recovery), plus logical exports via `ExportsService` — see [center-admin.md § Backup and recovery](../authors/center-admin.md#task-backup-and-recovery). |
| IMS Production Recovery | Replaced | Same — HANA Cloud point-in-time recovery. See [center-admin.md § Backup and recovery](../authors/center-admin.md#task-backup-and-recovery). |
| Add an Author to the IMS Application (BTP `IMS_Content_Author_dev` role) | Replaced | BTP role-collection assignment for `Tutorial.Author` (and other scopes) — see [center-admin.md § Add a user to the system](../authors/center-admin.md#task-add-a-user-to-the-system). |
| IMS Production URL (`https://imsprod-approuter.cfapps.us30.hana.ondemand.com/`) | Removed | The new endpoints are documented in [testing-endpoints.md](../developers/operations/testing-endpoints.md). |
| Define a New App Space Event (IMS Groups UI) | Replaced | Admin UI Events app — see [center-admin.md § Define an App Space event](../authors/center-admin.md#task-define-an-app-space-event). |
| Migrate Existing Tutorial(s) to Another Tutorial Repository (IMS-coordinated) | Replaced | Pure GitHub operation now — see [repo-group-owners.md § Migrate a tutorial to another repository](../authors/repo-group-owners.md#task-migrate-a-tutorial-to-another-repository). |

## CircleCI-era tasks

| Old task | Status | Replacement |
| --- | --- | --- |
| Administer CircleCI (lint pipeline for `sap-tutorials` org) | Replaced | The Sage VS Code extension provides equivalent linting at author time. The `tutorials-ims` test suite runs in CI via [GitHub Actions](../../.github/workflows/). |
| `tutorial-checker` repository (CircleCI lint script) | Partially retained | The lint script is no longer run, but `data/repository.owner.json` in the `sap-tutorials/tutorial-checker` repo is still the canonical owner registry — see [repo-group-owners.md § Canonical owner registry](../authors/repo-group-owners.md#canonical-owner-registry). |

## Concept changes

| Old concept | What replaced it |
| --- | --- |
| AEM as the frontend for `developers.sap.com/tutorials` | Hugo static site behind an XSUAA-protected AppRouter, content stored in HANA BLOBs and served by CAP. |
| AEM editorial workflow ("Quick Publish") | GitHub PR merge → repo dispatch → `tutorials-ims` CI → Hugo rebuild → HANA upload, with no manual publish step. |
| IMS as the progress-tracking backend | CAP Node.js service (`srv/`) backed by HANA Cloud. |
| Repository Group Curator (separate persona in old run-book) | Collapsed into Repo Group Owner and Center Admin — the new system has no distinct curator role. |

## See also

- [authors/README.md](../authors/README.md) — current operational manual
- [authors/center-admin.md](../authors/center-admin.md) — successor for most decommissioned admin tasks
- [authors/repo-group-owners.md](../authors/repo-group-owners.md) — successor for editorial tasks
- [authors/analytics-admin.md](../authors/analytics-admin.md) — successor for tutorial analytics
