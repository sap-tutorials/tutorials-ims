# Authoring branched tutorials

> **Audience:** Tutorial authors editing markdown in `sap-tutorials/<repo>` or its `*-Contribution` sibling.
> **Status:** v1 (issue #172, PR 3). Mission-level alt-groups are covered separately in [Authoring branched missions](./branched-missions.md).

A tutorial is a sequence of steps. Most are **linear** — the learner does each in order. **Branch groups** let you offer alternative step-runs *within one tutorial*: a contiguous run of H3 sub-steps marked as alternatives, with the learner picking one. **Skip-runs** let you mark a step as auto-skippable when the learner has already completed prerequisite content.

The classic example is a deployment fork:

> Step 1 → Step 2 → **Pick one: HANA Cloud or PostgreSQL** → Step 3 → Step 4

Both branches reach the same goal; the learner only needs to do one.

## What this is

You add two markers, `[BRANCH_BEGIN ...]` and `[BRANCH_END]`, around each alternative sub-run of H3 sub-steps. Consecutive sibling blocks with the same `group=` form one pickable group. The H3 immediately preceding the first `[BRANCH_BEGIN]` becomes the **parent step** for that group.

Skip-runs use per-step frontmatter (`skipIf`, `skipLabel`, `skipReason`) — no markers required.

## How to author a branch group

```markdown
### 4. Deploy the database

You'll deploy to either HANA Cloud or PostgreSQL. Pick the runtime your team uses.

[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud" condition="profile.deployment == 'cloud'"]

### 4a. Provision HANA Cloud

Open the BTP cockpit and create a HANA Cloud instance...

### 4b. Bind the service

Run `cf bind-service my-app my-hana`.

[BRANCH_END]

[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]

### 4a. Install PostgreSQL

`brew install postgresql@16` (macOS) or use the installer from postgresql.org...

### 4b. Create the database

`createdb mydb` and update `default-env.json`.

[BRANCH_END]

### 5. Verify the deployment
```

After the build, Step 4 has two pickable branches and Step 5 continues the linear backbone.

## Marker syntax reference

Each `[BRANCH_BEGIN ...]` accepts these attributes (double-quoted values; single-quote profile values *inside* `condition=`):

| Attribute | Required | Purpose |
|---|---|---|
| `group=` | yes | Short identifier shared across the alt-group's members. Letters, digits, dashes only. |
| `key=` | yes | Identifier for **this** branch. Unique within the group. Letters, digits, dashes only. |
| `label=` | yes | Display text on the picker chip (e.g. `HANA Cloud`). |
| `condition=` | no | Predicate that, when it evaluates true, causes the system to recommend this branch automatically. |

Rules:

- **Consecutive sibling blocks with matching `group=` form ONE pickable group.** A non-sibling element (heading, paragraph, fence) between two branch blocks splits them into separate groups — not what you usually want.
- **The H3 immediately preceding the first `[BRANCH_BEGIN]` becomes the parent step number.** The runtime BranchPointId is `<parentStep>-<groupKey>`.
- Each branch must contain at least one H3 sub-step. Empty branches fail the build.

## Skip-runs

Mark a single step as auto-skippable in its frontmatter:

```markdown
### 2. Install Node.js
<!--
skipIf: "completed:node-getting-started"
skipLabel: "Skip — I already have Node"
skipReason: "You completed the Node onboarding mission"
-->

Download Node 22 LTS from nodejs.org...
```

When the learner's state matches `skipIf`, they see a message strip with `[Skip ahead]` / `[Read anyway]` buttons. The choice is remembered per-(slug, step) in localStorage. No marker rewriting is needed.

## Conditions

The same predicate language as branched missions — see [Authoring branched missions § Conditions](./branched-missions.md#conditions-optional) for the full grammar. Quick reference:

| Form | Example |
|---|---|
| `completed:<slug>` | `completed:node-getting-started` |
| `completedMission:<slug>` | `completedMission:btp-cap-onboarding` |
| `profile.<field> == '<value>'` | `profile.deployment == 'cloud'` |
| `profile.<field> in ['<a>','<b>']` | `profile.role in ['developer','architect']` |

Combine with `&&` (or `and`), negate with `!`, group with `(...)`. Profile vocabulary is fixed in v1: `deployment`, `role`, `cloud`.

If a learner's state matches **any** branch's condition, that branch is recommended. If multiple match, the first declared wins. If none match, the runtime ranker picks based on the learner's interest (their completed-tutorial centroid).

## What the learner sees

- A **segmented-button picker** above the parent step, one chip per branch.
- The recommended chip carries an **AI-recommended glyph** and a small **reason chip** explaining the pick (e.g. *"You set deployment = cloud in your profile"*).
- For skip-runs, a `ui5-message-strip` at the top of the step with `[Skip ahead]` and `[Read anyway]` actions.
- All branches remain selectable — the recommendation is a hint, never a lock.

## Linkable

Authors and learners can deep-link a specific branch or skip choice:

| URL fragment | Effect |
|---|---|
| `?branch=<groupKey>:<branchKey>` | Force-select a branch on load. |
| `?skip=<stepNumber>=skip` or `=read` | Force a skip-run decision on load. |

These overrides also persist into localStorage so refreshes hold the choice.

## Validation rules

The build (`scripts/parsers/branches.ts`) fails hard on any of:

- Unbalanced markers (`[BRANCH_BEGIN]` without matching `[BRANCH_END]` or vice versa)
- Mismatched `group=` within a sibling block
- Duplicate `key=` within a group
- Nested `[BRANCH_BEGIN]` inside another branch
- Unparseable `condition=` predicate
- Empty branch (no H3 sub-steps)
- Missing required attribute (`group=`, `key=`, `label=`)

The non-blocking lint rail (`scripts/lint-tutorial-markdown.ts`) surfaces the same findings as JSON for trend tracking, and runs in `rebuild-content.yml` and the QA workflow.

## Limits in v1

- **No nested branches.** A branch can't contain another branch.
- **No cross-tutorial joins.** A branch can't link to a different tutorial's content.
- **branchPointId is derived from parent step number.** Renumbering steps breaks deep links and persisted localStorage. Stable step numbering matters.
- **Branch sub-step body fallback is plain `<pre>`** in v1 if hydration fails. Future work will preserve the full step renderer.

These are open in future work — file an issue if you need them.

## See also

- [Branching paths design (issue #172)](https://github.com/sap-tutorials/tutorials-poc/blob/main/docs/superpowers/specs/2026-06-09-172-branching-paths-design.md) (internal repo path)
- [Authoring branched missions](./branched-missions.md) — mission-level alt-groups (PR 2)
- [Branching cookbook](./branching-cookbook.md) — copy-paste examples
