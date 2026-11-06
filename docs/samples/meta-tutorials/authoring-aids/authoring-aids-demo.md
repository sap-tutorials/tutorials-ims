---
parser: v2
auto_validation: true
time: 10
tags: [ tutorial>beginner, topic>developer-tools ]
primary_tag: topic>developer-tools
author_name: SAP Developer Advocates
author_profile: https://github.com/sap-developers
---

<!-- This file is a reference sample, not a published tutorial. It demonstrates
     the three authoring aids: author notes (%% … %%), qa-only blocks, and the
     deprecated-cli lint rule. See docs/authors/authoring-aids.md for the full
     reference. -->

# Use Authoring Aids to Annotate and Review Tutorials

This tutorial shows you how to use the three authoring aids built into the
tutorial platform: inline and block author notes, QA-only content blocks, and
the CLI freshness lint rule. These tools help authors and reviewers collaborate
on tutorial content without affecting what production readers see.

### Prerequisites

- You have write access to a repository under the `sap-tutorials` GitHub organization
- You have the QA author-preview channel available at `/tutorials-qa/`
- You have Node.js installed locally

### You will learn

- How to embed reviewer comments directly in tutorial source
- How to include content that is visible only on the QA channel
- How the CLI freshness linter catches outdated commands at build time

---

### Step 1 — Add Author Notes to Mark Content for Review

Author notes let you leave comments for co-authors and reviewers directly in the
tutorial markdown. They are stripped before the HTML reaches production readers.

An inline note sits on the same line as prose, delimited by `%%`:

```markdown
Run the deployment command below %% @reviewer: confirm this works with SDK v4 — see issue #321 %% and wait for the output.
```

<!-- The inline author note above is intentional. On QA it renders as a styled
     callout showing "@reviewer: confirm this works with SDK v4". On PROD the
     entire %% … %% span is removed and readers see only the surrounding prose. -->

A block note spans multiple lines. A bare `%%` opens it and a bare `%%` closes it:

```markdown
%%
@author: The screenshot below is from the old tenant. Replace once the
new BTP tenant is provisioned — tracked in https://github.com/sap-tutorials/…/issues/88.
%%
```

<!-- The block note above shows a multi-line example. On QA it renders as a
     block callout attributed to "author". On PROD it is replaced with a single
     blank line so surrounding paragraphs remain separated. -->

%% @reviewer: Does the step flow here feel natural for a new author? Consider splitting into sub-steps if needed. %%

After you add a note, open the tutorial on the QA channel to verify it renders
as a callout. When the content is finalized, remove the notes before promoting
the tutorial to PROD.

[VALIDATE_1]

---

### Step 2 — Add QA-only Blocks for Reviewer Context

Sometimes you want to leave instructions for your reviewer that are not part of
the published content at all. Use a `:::qa-only` directive for this.

The block below is visible on the QA channel only. On PROD it is stripped
entirely, including this sentence:

:::qa-only[Reviewer checklist — remove or resolve before PROD promotion]
Before approving this tutorial for PROD, verify:

- The screenshots in Step 1 match the current BTP Cockpit UI
- The time estimate (10 minutes) is realistic for a new developer
- All code fences use the correct language tag (`bash`, `typescript`, etc.)
- No author notes (`%% … %%`) remain in the source

This block will not appear in the published tutorial. It is visible only on
`/tutorials-qa/` when you are logged in with the `Tutorial.Author` scope.
:::

<!-- The :::qa-only block above demonstrates how to embed reviewer checklists.
     The label "Reviewer checklist — remove or resolve before PROD promotion" is
     shown as the callout header on QA. The body (the bullet list) is shown below
     it. On PROD, the entire block including the label and body produces no HTML. -->

After reviewing the tutorial on QA, the block can stay in the source until the
review is complete. Remove it (or leave it if it is permanently useful for
future reviewers) before the final PROD push.

%%
@author: We could keep this qa-only block permanently as a standard review checklist.
Check with the team whether we want a shared template or per-tutorial checklists.
%%

[VALIDATE_2]

---

### Step 3 — Understand CLI Freshness Lint Findings

The tutorial platform runs `lint-tutorial-markdown` during `npm run build:all`.
One of its rules, `deprecated-cli`, scans every shell code fence for known
deprecated CLI commands.

The following example contains a deprecated `cf push` flag that the linter
catches at build time:

```bash
cf push myapp --hostname myhost
```

<!-- The bash fence above intentionally uses the deprecated --hostname flag.
     At build time the lint rule emits:

     [deprecated-cli] authoring-aids-demo.md:N
       The `--hostname` flag was removed in cf CLI v8. Use `routes:` in the
       application manifest instead.
       Replacement: Add `routes:\n  - route: <hostname>.<domain>` to manifest.yml
       Docs: https://docs.cloudfoundry.org/devguide/deploy-apps/manifest-attributes.html#routes
       Excerpt: cf push myapp --hostname myhost

     In a real tutorial, update the command to use the manifest-based approach shown below. -->

The corrected command uses an application manifest instead:

```yaml
# manifest.yml
applications:
  - name: myapp
    routes:
      - route: myhost.cfapps.eu10.hana.ondemand.com
```

```bash
cf push myapp
```

%% @author: The deprecated example above is intentional — it demonstrates what the linter catches. Do NOT fix it before the sample is reviewed by the team. %%

To run the linter locally against a single tutorial:

```bash
npx tsx scripts/lint-tutorial-markdown.ts authoring-aids-demo
```

Pass `--strict` if you want a non-zero exit code when findings are present (useful in CI pre-checks).

[VALIDATE_3]
