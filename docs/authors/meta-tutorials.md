# Meta Tutorials — the tutorials that teach you to write tutorials

The `sap-tutorials/meta-tutorials-Contribution` repo holds the platform's own
"how to author" content: a set of tutorials that walk a new author from an empty
machine all the way through writing, validating, and publishing a tutorial.

Because they live in a `*-Contribution` repo, they are **not** published to the
public catalog at `developers.sap.com/tutorials/`. Instead they are exposed on
the **QA author-preview channel** at `/tutorials-qa/<slug>`, so authors can read
them exactly as a reader would — rendered by the same Hugo pipeline, before
anything reaches production. See [QA Channel Bootstrap](../developers/operations/qa-channel-bootstrap.md)
for how that channel is wired.

> **Access.** The QA channel is XSUAA-gated and needs the `Tutorial.Author`
> scope. Open the links below in a browser where you're logged in to the
> platform — an unauthenticated request lands on the login shell, not the page.

**QA base URL (production deployment):**

```
https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/<slug>
```

---

## Recommended path

Read these roughly in order. Steps 1–2 orient you; 3 sets up tooling; 4–7 are the
core author loop (write → validate → publish); 8+ are for groups, files, and
day-to-day monitoring.

### 1. Orientation

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 1 | [The Big Picture on Tutorials](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-0-big-picture-2022) | 30 min | The purpose of our tutorials and how the whole authoring system fits together. |
| 2 | [Configure your machine for Tutorial Authoring](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-1-getting-started-newv2) | 30 min | How to plan for writing tutorials and get your local environment ready. |

### 2. Choose and set up your editor

Pick the toolchain you'll author in. **VS Code + Sage is the current
recommendation**; the Atom helper tutorials are legacy and only needed if you're
maintaining older workflows.

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 3 | [Use Visual Studio Code to Author Tutorials](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/vscode-getting-started) | 10 min | How to author `.md` and `.vr` files in Visual Studio Code. |
| 4 | [Install and Set Up the Sage Tutorial Authoring Extension](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/sage-getting-started) | 30 min | How to download, install, and use the Sage VS Code extension for author-time linting and preview. |
| — | [Prepare Atom Editor for Individual Repos (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/update-tutorial-helperv2) | 10 min | _(Legacy)_ Prepare the Atom editor to write and publish with individual GitHub repositories. |
| — | [Prepare Atom Editor for Individual Repos](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/update-tutorial-helper) | 10 min | _(Legacy, pre-v2)_ Same as above for the original parser. |

### 3. Write

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 5 | [Create a Tutorial](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-2-writing-tutorial-newv2) | 15 min | How to create a new tutorial from scratch. |
| 6 | [Update an Existing Tutorial (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-2a-updating-tutorialv2) | 5 min | How to update a tutorial that's already published. |
| — | [Examples of Markdown Syntax for v2 Parser](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/v2-example-tutorial) | 10 min | A reference of every markdown/callout/validation construct the v2 parser supports. Keep it open while you write. |
| — | [(Optional) Create a new tutorial using the DITA CMS (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-6-dita-markdownv2) | — | For UA information developers: author from the DITA CMS using the 1DX markdown output type, then deploy to QA. |

### 4. Validate

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 7 | [Add Validation to a Tutorial (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-3-adding-validationv2) | 10 min | How to create a rules file with validation steps so readers can check their work. |

### 5. Publish and manage

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 8 | [Publish a Tutorial to Production (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-4-publishing-production-newv2) | 5 min | How to move your tutorial from your fork through to production. |
| 9 | [Delete a Tutorial from QA (v2 parser)](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-6-delete-tutorialv2) | 5 min | How to delete a tutorial from QA that is not yet in production. |
| 10 | [Groups and Missions](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/docs-tutorial-5-create-groupv2) | 10 min | How to compose and request a tutorial mission or group. |

### 6. Supporting tools

| # | Tutorial | Time | What you'll learn |
| --- | --- | --- | --- |
| 11 | [Upload Files to FCMS for Developer Downloads](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/fcms-upload-file) | 10 min | How to gain access to FCMS and upload downloadable assets for your tutorial. |
| 12 | [Introduction to the Tutorial Dashboard](https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/tutorial-dashboard-intro) | 10 min | How to access the Tutorial Dashboard to monitor the health of your content. |

---

## Notes and caveats

- **16 meta tutorials are live** on the QA channel and verified reachable
  (2026-07-25).
- **Three slugs are stale.** `use-autoauthor-to-generate-quiz-questions`,
  `use-codecheck-to-ai-grade-reader-code`, and
  `use-validate-to-ai-grade-free-text-answers` appear in the QA discovery index
  but currently return **404** — the source markdown is no longer present in the
  `meta-tutorials-Contribution` repo. They are omitted above. If you're expecting
  the AI-assisted authoring tutorials (AutoAuthor / CodeCheck / Validate), check
  with the platform team whether they've been renamed or unpublished; the
  discovery index needs a `fetch-tutorials:qa` re-run to drop the dead entries.
- The two **Atom** editor tutorials are legacy. New authors should use
  **VS Code + Sage** and can skip them.

## Related

- [Writing tutorials](./writing-tutorials.md) — this repo's own author workflow (fetch → parse → Hugo → HANA)
- [Repo / group owners](./repo-group-owners.md) — reviewing PRs and managing `sap-tutorials` repos
- [QA Channel Bootstrap](../developers/operations/qa-channel-bootstrap.md) — how the `/tutorials-qa/*` preview channel is set up
- [Sage VS Code extension](../developers/reference/sage-extension-migration.md) — author-time linting and preview
