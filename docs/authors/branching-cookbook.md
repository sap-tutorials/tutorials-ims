# Branching cookbook

> **Audience:** Tutorial authors looking for working examples to copy.
> **Status:** v1 (issue #172, PR 3). For background see [Authoring branched tutorials](./branched-tutorials.md) and [Authoring branched missions](./branched-missions.md).

Three copy-paste-ready patterns for the most common branching shapes.

## 1. Cloud vs on-prem fork

**Use this when** the tutorial bifurcates on deployment target (cloud vs local, HANA vs PostgreSQL, BTP vs ABAP) and you can predict which one a learner will pick from their profile. The first branch carries a `condition=`; the second is the deterministic-default fallback (no condition).

```markdown
### 3. Configure the database

The next two sub-steps differ depending on whether you're deploying to HANA Cloud or running PostgreSQL locally.

[BRANCH_BEGIN group="db-runtime" key="hana" label="HANA Cloud" condition="profile.deployment == 'cloud'"]

### 3a. Bind the HANA Cloud service

Run `cf bind-service my-app my-hana-hdi`.

### 3b. Verify the binding

`cf env my-app | grep hana` — you should see HDI credentials.

[BRANCH_END]

[BRANCH_BEGIN group="db-runtime" key="postgres" label="PostgreSQL"]

### 3a. Start PostgreSQL

`brew services start postgresql@16` (macOS).

### 3b. Configure default-env.json

Add a `db` entry pointing at `postgres://localhost:5432/mydb`.

[BRANCH_END]

### 4. Run the migrations
```

**What the learner sees:** a two-chip segmented picker `[HANA Cloud ★] [PostgreSQL]` above Step 3. Learners with `profile.deployment = 'cloud'` get the HANA chip pre-selected with a reason chip; everyone else gets a ranker recommendation but can flip to PostgreSQL with one click.

## 2. IDE pick (no profile condition)

**Use this when** branches are equally likely and you have no profile signal to decide. Both branches omit `condition=` so the runtime ranker uses each branch's `embeddingHint` (= the title of its first H3 sub-step) to pick based on the learner's recent completions.

```markdown
### 2. Open the project in your IDE

[BRANCH_BEGIN group="ide" key="vscode" label="VS Code"]

### 2a. Install the recommended extensions

Open the Command Palette and run *Extensions: Show Recommended Extensions*. Install the SAP Fiori tools and CDS Language Support.

### 2b. Open the workspace

`File → Open Workspace from File…` and pick `project.code-workspace`.

[BRANCH_END]

[BRANCH_BEGIN group="ide" key="intellij" label="IntelliJ IDEA"]

### 2a. Import as a Maven project

`File → Open…`, select `pom.xml`, and choose *Open as Project*.

### 2b. Configure the JDK

Set the project SDK to JDK 22 in *File → Project Structure*.

[BRANCH_END]

### 3. Start the dev server
```

**What the learner sees:** `[VS Code] [IntelliJ IDEA]`. The ranker pre-selects whichever the learner's centroid leans toward (e.g. someone with VS Code-heavy content history sees `[VS Code ★]`). Either chip is one click away.

## 3. Skip ahead — "I already did this"

**Use this when** a step duplicates content the learner has likely already done in a prerequisite tutorial or mission. No markers needed — just step frontmatter.

```markdown
### 1. Install Node.js
<!--
skipIf: "completed:node-getting-started"
skipLabel: "Skip — I already have Node"
skipReason: "You completed the Node onboarding mission"
-->

Download Node 22 LTS from [nodejs.org](https://nodejs.org/).

Verify with:

```bash
node --version
```

You should see `v22.x.x`.
```

**What the learner sees:** a `ui5-message-strip` at the top of Step 1 saying *"You completed the Node onboarding mission"* with `[Skip ahead]` and `[Read anyway]` buttons. Picking *Skip ahead* jumps to Step 2 and remembers the choice in localStorage; picking *Read anyway* hides the strip but keeps the step in flow.

## When to use which

| Pattern | Picks one of N? | Skips an entire step? | Best when |
|---|---|---|---|
| **Branch group** (alt-group within a tutorial) | Yes | No | Two or more contiguous H3 sub-runs cover the same goal differently. |
| **Skip-run** | No | Yes | The step is fully redundant for some learners (covered elsewhere). |

Branch groups and skip-runs compose freely — a tutorial can have several of each.

## Testing your conditions with the debug override {#debug-override}

> **Audience:** authors with `Tutorial.Author` or `Admin` scope.

When you write a `[BRANCH_BEGIN ... condition="profile.deployment == 'cloud'"]` directive, you need a way to test both arms of the branch without changing your own learning preferences in `/me/`. The `?profile.<field>=<value>` query parameter does exactly that.

**Format:** add `?profile.<field>=<value>` to any tutorial URL. Multiple fields are AND-ed:

```text
https://.../tutorials-qa/<slug>/?profile.deployment=cloud
https://.../tutorials-qa/<slug>/?profile.deployment=onprem&profile.role=architect
```

**Allowed values** (see [pilot-runbook.md#phase-1-pre-pilot](./pilot-runbook.md#phase-1-pre-pilot) for the v1 vocabulary):

- `profile.deployment`: `cloud`, `onprem`
- `profile.role`: `developer`, `architect`, `sysadmin`, `student`
- `profile.cloud`: `btp`, `aws`, `gcp`

**Cache fingerprint:** the override is mixed into the per-callsite cache key, so override-mode traffic gets a separate cache slot from learner-mode traffic. You won't poison cache for real learners.

**Invalid values are silently dropped.** `?profile.deployment=hybrid` is treated as if no override were sent for `deployment`.

**Empty strings are treated as missing.** `?profile.deployment=` is the same as omitting the field.

**Without `Tutorial.Author` or `Admin` scope:** the override is silently ignored (parser returns null). The widened gate (`Tutorial.Author OR Admin`) lets admins test the override on their existing role-collection without needing a separate Tutorial.Author grant.

**Joule narration ignores overrides.** The chat-orchestrator runs through a CAP `req`, not the express request, so `?profile.*` doesn't reach the narration tool. To test branch narration, clear the override from the URL and chat from the unmodified URL. (Plumbing the override through chat is a v2 candidate.)

**Stale-after-write workaround:** if you just edited your own preferences in `/me/` and want to bypass the 5-minute TTL on the per-callsite cache, combine with `?nocache=1`:

```text
https://.../tutorials-qa/<slug>/?profile.deployment=cloud&nocache=1
```

For the canonical pilot-time debug walkthrough, see [Phase 2: QA pilot](./pilot-runbook.md#phase-2-qa-pilot) in the pilot runbook.
