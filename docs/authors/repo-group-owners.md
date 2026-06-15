# Repo Group Owners

Operational manual for owners of a tutorial repository in the [`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization.

## Persona summary

- **Role:** Editorial and review authority for one or more tutorial repos under `sap-tutorials`.
- **Tools and access:**
  - GitHub admin on the repos you own
  - Optional: `Tutorial.Author` BTP role-collection scope for the QA author-preview channel — request from a [Center Admin](center-admin.md)
  - Local clone of [`tutorials-ims`](https://github.com/sap-tutorials/tutorials-ims) for reviewing renders before merge

## Canonical owner registry

`sap-tutorials/tutorial-checker/data/repository.owner.json` is the canonical list of repository group owners. It is a CircleCI-era artifact that survives in the new system because it is the only place the owner-name → SAP-email mapping is held; the [Center Admin](center-admin.md) cross-references it with the `Accounts` records in the admin UI.

If you change role, update this file (Task: Designate or change a repository group owner below).

---

### Task: Wire your repo for auto-publish
- **Interval:** Once per repo
- **Status:** Active
- **Purpose and Objective:** When a tutorial PR merges to `main`, trigger a rebuild of the published site so the change goes live within minutes.
- **Prerequisites:** GitHub admin on the source repo; a `DISPATCH_TOKEN` repo secret obtained from a [Center Admin](center-admin.md).

1. Copy [`docs/tutorial-repo-dispatch.yml`](tutorial-repo-dispatch.yml) from `tutorials-ims` into your repo at `.github/workflows/tutorial-repo-dispatch.yml`.
2. In the source repo's Settings → Secrets and variables → Actions, add a secret named `DISPATCH_TOKEN` with the value supplied by the Center Admin.
3. Commit the workflow file on `main`.
4. Verify: push a small change (e.g., a typo fix) and watch the `tutorials-ims` repo's Actions tab for a triggered run within ~10 seconds.
5. If the run does not appear, check the source repo's Actions log for the dispatch step. The most common failure is a stale or missing `DISPATCH_TOKEN`.

**Related:** [Center Admin: Force-rebuild content](center-admin.md), [build.md](../developers/architecture/build.md)

---

### Task: Review and merge pull requests
- **Interval:** Daily
- **Status:** Active
- **Purpose and Objective:** Catch frontmatter, structure, and metadata issues before they reach the build pipeline.
- **Prerequisites:** GitHub admin on the source repo; optional local `tutorials-ims` clone.

Review checklist (verify each PR before merge):

- [ ] Frontmatter is valid YAML (no tabs, quoted tags with colons).
- [ ] `parser: v2` is set.
- [ ] `primary_tag`, `tags`, `time` (integer minutes), and an H1 title are present.
- [ ] A `<!-- description -->` line follows the H1.
- [ ] Every step is an `### H3`. No H1/H2 inside step bodies.
- [ ] All images referenced from Markdown exist in the slug-named folder alongside the .md file.
- [ ] Image paths are relative, not absolute `https://github.com/...` URLs.
- [ ] Code fences carry a language tag.
- [ ] If `OPTION` blocks are used, every `BEGIN` has a matching `END`.
- [ ] The slug (filename without `.md`) does not collide with any existing tutorial across the org. If unsure, search the `sap-tutorials` org for the slug.

For larger or higher-risk changes, render locally:

```bash
cd tutorials-ims
npm run fetch-tutorials
npm run dev
```

Open `http://localhost:1313/tutorials/<slug>` and walk through the rendered tutorial.

Escalate to a [Center Admin](center-admin.md) if:
- Slug collision with another repo's tutorial.
- A new tag is needed that is not yet in the platform taxonomy.
- The author asks for a preview deploy beyond local Hugo or the QA channel.

**Related:** [writing-tutorials.md § 6 Pre-submit checklist](writing-tutorials.md), [Center Admin: Import a new tag](center-admin.md)

---

### Task: Triage repo issues
- **Interval:** Bi-weekly
- **Status:** Active
- **Purpose and Objective:** Keep the repo's open-issue queue moving; route platform issues to `tutorials-ims`.
- **Prerequisites:** GitHub triage permission on the source repo.

1. Sweep all open issues with no recent activity. Apply labels: `bug`, `enhancement`, `question`, `tutorial-needs-fix`, `platform`.
2. **Tutorial content issues** (a step is wrong, a screenshot is outdated, etc.) — assign to the author or a relevant reviewer.
3. **Platform issues** (rendering bug, build failure, infrastructure question) — re-file as a new issue in `sap-tutorials/tutorials-ims` and close the source-repo issue with a link.
4. **Stale questions** older than 30 days with no author response — close with a polite "please reopen if still relevant" message.

**Related:** [tutorials-ims Issues](https://github.com/sap-tutorials/tutorials-ims/issues)

---

### Task: Review tutorial planning outlines
- **Interval:** As requested by authors
- **Status:** Active
- **Purpose and Objective:** Catch structural issues before authoring effort is spent.
- **Prerequisites:** Familiarity with the tutorial navigator's group and mission structure.

When an author proposes a new tutorial or set of tutorials:

1. **Logical chunking.** Each tutorial should be 10–30 minutes. If the proposed scope is bigger, suggest splitting into a Group; if smaller, suggest folding into an existing tutorial as a step.
2. **Time estimates.** Reality-check the `time` value against the proposed step count. ~3–5 minutes per substantive step is typical.
3. **Group vs Mission.** A **Group** is a topical collection (e.g., "ABAP cloud development basics"). A **Mission** is a sequenced learning path with completion certificates (e.g., "Build your first SAP BTP app"). If the author wants completion tracking with a fixed order, recommend Mission.
4. **Tag check.** Verify the proposed `primary_tag` and `tags` are in the existing taxonomy. If new tags are needed, route the author to a [Center Admin](center-admin.md).
5. **Duplication check.** Search the navigator for similar existing tutorials. If significant overlap, suggest extending the existing tutorial instead.
6. Provide written feedback. Approve or request revisions before authoring begins.

**Related:** [Center Admin: Add / revise / delete a Mission](center-admin.md), [Center Admin: Add / revise / delete a Group](center-admin.md)

---

### Task: Retire a tutorial
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Remove a tutorial that is no longer correct or no longer relevant.
- **Prerequisites:** GitHub write access to the source repo.

1. Open a PR in the source repo that deletes:
   - The tutorial's `.md` file under `tutorials/`.
   - The slug-named image folder alongside it.
   - Any `rules.vr` file with the same slug in the matching `-Contribution` repo (separate PR).
2. Mention "retires `<slug>`" in the PR description and link any successor tutorial.
3. Merge after review.
4. The publish pipeline marks the slug `RETIRED` in the next manifest. Hugo no longer builds the page.
5. **If the slug had production traffic** (check with the [Analytics Admin](analytics-admin.md) if in doubt), notify a [Center Admin](center-admin.md) so a redirect can be set up — otherwise readers hit a 404.

**Related:** [Center Admin: Retire a tutorial (admin side)](center-admin.md), [historic/decommissioned-tasks.md](../historic/decommissioned-tasks.md)

---

### Task: Migrate a tutorial to another repository
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** Move a tutorial when topical scope shifts (e.g., moves from "abap-core" to "abap-environment").
- **Prerequisites:** GitHub write access to both repos.

1. Coordinate with the destination repo's owner. Agree on the slug (it should not change — slug uniqueness is org-wide and link-stable).
2. In the destination repo, open a PR that adds the `.md` file and image folder.
3. In the source repo, open a separate PR that deletes them.
4. Merge the destination PR **first** so there is no window where the slug renders nothing.
5. The publish pipeline picks up both changes; manifest version increments once.

**Related:** [Retire a tutorial](#task-retire-a-tutorial)

---

### Task: Designate or change a repository group owner
- **Interval:** When work assignments change
- **Status:** Active
- **Purpose and Objective:** Keep the canonical owner registry current.
- **Prerequisites:** GitHub write access to `sap-tutorials/tutorial-checker`.

1. Open a PR against `sap-tutorials/tutorial-checker` that updates `data/repository.owner.json`. The top-level keys are repo group names (e.g., `"Tutorials"`); the value is `{ "name": "<github-handle>", "email": "<sap-email>" }`.
2. After merge, notify a [Center Admin](center-admin.md) so they can update the `Accounts` records in the admin UI.
3. The new owner needs GitHub admin on the affected repos — the existing owner or a Center Admin grants this.

**Related:** [Center Admin: Maintain the repo group owner list](center-admin.md)

---

### Task: Office hours and author support intake
- **Interval:** As needed
- **Status:** Active
- **Purpose and Objective:** First-line support for authors of repos you own.
- **Prerequisites:** None.

Handle locally:
- "How do I structure a step?" / "Why doesn't my image render?" — point at [writing-tutorials.md](writing-tutorials.md).
- "My PR was rejected by the linter" — review the validation error in the PR check.
- "Can I add a quiz?" — direct to the `*-Contribution` repo for `rules.vr`.

Forward to a [Center Admin](center-admin.md):
- Tag taxonomy questions or new-tag requests.
- BTP scope or access questions.
- Anything involving the published catalog (groups, missions, redirects).

**Related:** [Center Admin: Handle author support requests](center-admin.md)
