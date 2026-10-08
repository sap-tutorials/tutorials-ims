# Authors and Operators

This folder is the operational manual for everyone working with the SAP Developers tutorial system. It replaces the historical `meta-tutorials` run-book.

## Pick your persona

If you have never published through this platform, start with **New tutorial author** — it comes first because you complete it first. Once you are set up and writing markdown day-to-day, **Tutorial author** is your reference.

| If you are a... | Read | What you do |
| --- | --- | --- |
| **New tutorial author** learning the ropes | [meta-tutorials.md](meta-tutorials.md) | First time here: follow the platform's own "how to write a tutorial" tutorials (on the QA channel) to get set up end-to-end |
| **Tutorial author** writing markdown | [writing-tutorials.md](writing-tutorials.md) | Already onboarded: write, preview, and publish tutorials as part of your ongoing work |
| **Any author** getting a change merged | [branch-protection-and-pull-requests.md](branch-protection-and-pull-requests.md) | Branches, forks, and PRs under the OSPO branch-protection rules (no more direct pushes to `main`) |
| **Repo group owner** in `sap-tutorials` | [repo-group-owners.md](repo-group-owners.md) | Review PRs, plan tutorials, manage your repos |
| **Center admin** running the platform | [center-admin.md](center-admin.md) | Catalog, taxonomy, pipeline, access, support |
| **Analytics admin** exploring usage | [analytics-admin.md](analytics-admin.md) | Run queries, monitor events, export data |

## Requesting QA channel access

Previewing your tutorials on the [QA channel](#tools-that-complement-these-docs) (`/tutorials-qa/*`) requires the **`Tutorial.Author`** BTP scope, granted through the **`Tutorials Author`** role collection. New authors do not have it by default — you request it once.

**To request access, do either of the following:**

- Post a request in the **Tutorial Authors** channel in Microsoft Teams, **or**
- Email **[thomas.jung@sap.com](mailto:thomas.jung@sap.com)**.

Include the **SAP e-mail address** (SAP IDP identity) that you log in to the platform with — that is the identity the role collection is assigned to.

After your access is granted you must **log out and log back in** to the platform so your new scope appears in your session; until then `/tutorials-qa/*` returns a 403 even once the grant is in place.

> **For operators:** the mechanics of assigning the `Tutorials Author` role collection (BTP Cockpit and `btp` CLI) are documented in [XSUAA Role Collection Assignment](../developers/operations/xsuaa-role-collection-assignment.md).

## Branching paths (issue #172)

- [Authoring branched missions](./branched-missions.md) — pick-one alternatives within a mission
- [Authoring branched tutorials](./branched-tutorials.md) — alternative step-runs and skip-runs within a single tutorial
- [Branching cookbook](./branching-cookbook.md) — copy-paste examples for cloud/on-prem, IDE pick, and skip-ahead
- [Reading branch telemetry](./reading-branch-telemetry.md) — how to interpret the Branch Performance section in the Missions admin app, and when the staleness lint suggests collapsing a branch.

## System landmarks

- **Source repos** — [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization (one repo per topical group)
- **Platform repo** — [`sap-tutorials/tutorials-ims`](https://github.com/sap-tutorials/tutorials-ims) (this repo)
- **Admin UI** — `/admin-ui/` on the deployed app (XSUAA-gated, `Admin` scope)
- **Analytics UI** — `/analytics-ui/` on the deployed app (`Admin` scope)
- **Public site** — `https://developers.sap.com/tutorials/<slug>`
- **HANA Cloud** — managed instance bound to the CAP `srv` app; backups via BTP cockpit
- **Cloud Foundry** — `dev` and `prod` spaces in the `tutorial-system` subaccount

## Adding a task that isn't here yet

If you find yourself doing something operationally important that isn't documented:

1. Decide which persona file it belongs in (or whether it's a historic mapping for `../historic/`).
2. Use the standard task template — heading with verb-led title, **Interval**, **Status**, **Purpose and Objective**, **Prerequisites**, numbered steps, **Related** links.
3. Open a PR against this folder.

## Tools that complement these docs

- [Sage VS Code extension](../developers/reference/sage-extension-migration.md) — author-time linting and preview.
- [QA channel](../developers/operations/qa-channel-bootstrap.md) — author-preview for `*-Contribution` repo content (`Tutorial.Author` scope required).

## Deeper technical references

- [build.md](../developers/architecture/build.md) — fetch → parse → Hugo → HANA in detail
- [mta-deployment.md](../developers/operations/mta-deployment.md) — how the MTA is structured and deployed
- [authentication.md](../developers/architecture/authentication.md) — XSUAA, role collections, IAS
- [testing-endpoints.md](../developers/operations/testing-endpoints.md) — canonical endpoint reference for smoke testing

## Historic context

- [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md) — historic task mapping

## Updating the docs site sidebar

When you add a new page under `docs/end-users/`, `docs/authors/`, `docs/developers/`, or `docs/historic/`, you must register it in the sidebar at [`docs/.vitepress/config.ts`](../.vitepress/config.ts) under the matching persona block. The build runs `scripts/check-docs-sidebar.cjs` as `predocs:build` — it fails with a clear diff if a page is unregistered or a link is dead.

Run locally to verify:

```bash
npm run docs:build
```
