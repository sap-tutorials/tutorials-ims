# Authors and Operators

This folder is the operational manual for everyone working with the SAP Developers tutorial system. It replaces the historical `meta-tutorials` run-book.

## Pick your persona

| If you are a... | Read | What you do |
| --- | --- | --- |
| **Tutorial author** writing markdown | [writing-tutorials.md](writing-tutorials.md) | Write, preview, and publish tutorials |
| **Repo group owner** in `sap-tutorials` | [repo-group-owners.md](repo-group-owners.md) | Review PRs, plan tutorials, manage your repos |
| **Center admin** running the platform | [center-admin.md](center-admin.md) | Catalog, taxonomy, pipeline, access, support |
| **Analytics admin** exploring usage | [analytics-admin.md](analytics-admin.md) | Run queries, monitor events, export data |

## System landmarks

- **Source repos** — [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization (one repo per topical group)
- **Platform repo** — [`sap-tutorials/tutorials-poc`](https://github.com/sap-tutorials/tutorials-poc) (this repo)
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

- [Sage VS Code extension](../sage-extension-migration.md) — author-time linting and preview.
- [QA channel](../qa-channel-bootstrap.md) — author-preview for `*-Contribution` repo content (`Tutorial.Author` scope required).

## Deeper technical references

- [build.md](../developers/architecture/build.md) — fetch → parse → Hugo → HANA in detail
- [mta-deployment.md](../mta-deployment.md) — how the MTA is structured and deployed
- [authentication.md](../developers/architecture/authentication.md) — XSUAA, role collections, IAS
- [testing-endpoints.md](../testing-endpoints.md) — canonical endpoint reference for smoke testing

## Historic context

- [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md) — historic task mapping
