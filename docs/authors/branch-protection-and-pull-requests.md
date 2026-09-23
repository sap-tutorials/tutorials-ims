# Branch Protection & Pull Requests for Authors

**Why this page exists:** In September 2026, SAP's Open Source Program Office (OSPO) applied an
organization-wide branch-protection ruleset to every repository in the
[`sap-tutorials`](https://github.com/sap-tutorials) GitHub organization. **You can no longer push
directly to the default branch** (`main` or `master`). Every change — even a one-line typo fix —
now goes through a **pull request** that must be **reviewed and approved** before it can be merged.

If you used to `git push` straight to `main`, this page is the new workflow you must follow. It
explains the concepts (branches, forks, pull requests), the exact rules OSPO enforces, and gives
you step-by-step instructions for both the web UI and the command line.

> [!IMPORTANT]
> This changes *how* you get content in, not *what* you write or *what happens after merge*. Once
> your PR is merged, the publish pipeline behaves exactly as before — see
> [writing-tutorials.md](writing-tutorials.md) §7 "What happens after merge".

---

## 1. The rules, in one table

These are the actual rules enforced by the OSPO ruleset **"Protect default branch (org-wide)"**,
applied to the **default branch** of every repo in `sap-tutorials`. Verified live via the GitHub
API on 2026-09-23.

| Rule | What it means for you |
|------|-----------------------|
| **No direct pushes** | You cannot `git push` to `main`/`master`. The push is rejected. All changes arrive via pull request. |
| **Pull request required** | Every change to the default branch must go through a PR. |
| **≥ 1 approving review** | A PR needs **at least one approval** from someone other than the author before it can merge. |
| **Stale reviews dismissed on push** | If you push new commits *after* getting an approval, that approval is **cleared** and you must be re-approved. |
| **Extra approval for unattributed changes** | If a commit's author can't be matched to a GitHub identity (e.g. a bad `user.email`), the PR needs an **additional** approval. Set your git identity correctly to avoid this — see §7. |
| **No force-pushes** | `git push --force` to the default branch is blocked (`non_fast_forward`). |
| **No branch deletion** | The default branch cannot be deleted. |
| **No bypass** | There is **no bypass list**. Repo admins and org owners follow the same rules — nobody can push directly. |

**What is NOT required** (so you don't over-think it): code-owner review is *not* mandated,
last-push approval is *not* required, and review-thread resolution is *not* enforced by the rule.
All three merge methods (**merge**, **squash**, **rebase**) are allowed.

> [!NOTE]
> The rule targets `~DEFAULT_BRANCH`, so it protects whatever the repo's default branch is named.
> Most tutorial repos use `main`; a few older ones (e.g. `Tutorials`) still use `master`. The
> protection applies either way. This guide writes `main` — substitute `master` where your repo
> uses it. Check with `git remote show origin | grep "HEAD branch"`.

---

## 2. Concepts you need (branch, fork, pull request)

If these terms are already second nature, skip to §4.

### 2.1 Branch

A **branch** is a parallel line of work inside a repository. The **default branch** (`main`) is the
"official" version that the tutorial platform publishes from. When you create a branch, you get an
isolated copy of the files where you can commit freely without touching `main`.

```text
main:     A───B───C           ← protected, publishes to developers.sap.com
                   \
your-branch:        D───E      ← your work-in-progress, safe to push
```

You do your editing on **your branch**, then propose merging it back into `main` via a pull request.

### 2.2 Fork

A **fork** is your *personal copy of the entire repository* under your own GitHub account
(`your-username/abap-core-development`). It's a separate repo that remembers where it came from
("upstream"). You push branches to your fork, then open a PR **from your fork into the upstream
`sap-tutorials` repo**.

**Do you need a fork?** It depends on your access:

| Your situation | Use | Why |
|----------------|-----|-----|
| You have **write (push) access** to the `sap-tutorials` repo | **Branch directly in the repo** (§4) | Simpler — no fork to keep in sync. You still cannot push to `main`, only to your own branch. |
| You are an **external contributor** with no write access | **Fork** (§5) | You can't create branches in a repo you can't push to. Fork, branch in your fork, PR upstream. |
| Not sure | Try §4; if `git push` to a new branch is rejected with a permissions error, use §5 | — |

Both paths end at the same place: **a pull request into the protected `main`.**

### 2.3 Pull request (PR)

A **pull request** is a proposal: "please merge the commits on *my branch* into *your `main`*." It's
where review happens — a reviewer reads the diff, comments, and clicks **Approve**. Once the PR has
the required approval and passes any checks, it can be **merged**, which is the *only* way changes
now reach `main`.

---

## 3. The new workflow at a glance

```text
OLD (no longer possible)              NEW (required)
────────────────────────             ──────────────────────────────────────
edit on main                         1. branch off main  (or fork, then branch)
git commit                           2. edit + commit on the branch
git push origin main   ✗ REJECTED    3. push the branch  (to repo or your fork)
                                     4. open a pull request → main
                                     5. get ≥ 1 approval
                                     6. merge the PR   ← this reaches main
                                     7. pipeline publishes (unchanged)
```

---

## 4. Step by step — you HAVE write access (branch in the repo)

Use this if you can push to the `sap-tutorials` repo (most SAP-internal authors and repo group
owners).

### 4.1 Command line

```bash
# 1. Clone (once) and move into the repo
git clone https://github.com/sap-tutorials/abap-core-development.git
cd abap-core-development

# 2. Make sure you start from the latest main
git checkout main
git pull origin main

# 3. Create a branch — name it after your change
git checkout -b fix/typo-in-abap-cloud-ui

# 4. Edit your .md files / add images, then stage and commit
git add tutorials/abap-cloud-ui-from-interface.md
git commit -m "Fix broken image path in abap-cloud-ui-from-interface"

# 5. Push YOUR BRANCH (never main)
git push -u origin fix/typo-in-abap-cloud-ui

# 6. Open the PR (gh CLI). --base main --head is your branch (implied by -u above)
gh pr create --base main \
  --title "Fix broken image path in abap-cloud-ui-from-interface" \
  --body  "Corrects a relative image path that 404'd on the published page."
```

`gh pr create` prints the PR URL. Share it, or wait for a reviewer to pick it up.

### 4.2 Web UI (no local git)

You can do the whole thing in the browser — good for quick text edits:

1. Browse to the file on `github.com/sap-tutorials/<repo>`.
2. Click the **pencil (Edit)** icon.
3. Make your edit.
4. Click **Commit changes…**. GitHub will not let you commit to `main`; it offers
   **"Create a new branch for this commit and start a pull request."** Leave that selected, name
   the branch, and click **Propose changes**.
5. On the next screen, click **Create pull request**.

That's the same result as the CLI path — a branch plus a PR into `main`.

---

## 5. Step by step — you do NOT have write access (fork + PR)

Use this if you're an external contributor or `git push` to a new branch fails with a
`403`/permission error.

```bash
# 1. Fork via the CLI (or click "Fork" on the repo page in the browser)
gh repo fork sap-tutorials/abap-core-development --clone
cd abap-core-development

# gh sets up two remotes for you:
#   origin   → your fork          (you can push here)
#   upstream → sap-tutorials/...  (you open PRs against this; read-only to you)

# 2. Start from an up-to-date main
git checkout main
git pull upstream main

# 3. Branch, edit, commit
git checkout -b add/new-hana-tutorial
git add tutorials/my-new-tutorial.md tutorials/my-new-tutorial/
git commit -m "Add tutorial: my-new-tutorial"

# 4. Push the branch to YOUR FORK (origin)
git push -u origin add/new-hana-tutorial

# 5. Open the PR from your fork into upstream main
gh pr create --repo sap-tutorials/abap-core-development \
  --base main --head <your-github-username>:add/new-hana-tutorial \
  --title "Add tutorial: my-new-tutorial" \
  --body  "New beginner tutorial for SAP HANA Cloud."
```

**Keeping your fork current** (do this before starting new work, so you branch from fresh code):

```bash
git checkout main
git pull upstream main       # pull the org's latest
git push origin main         # update your fork's main to match
```

---

## 6. Getting your PR approved and merged

1. **Request a review.** In the PR page, under **Reviewers**, request your
   [repo group owner](repo-group-owners.md), or ask in the platform team channel. A reviewer must
   click **Approve** — your own review does not count toward the required approval.
2. **Address feedback.** If the reviewer requests changes, commit them on the **same branch** and
   push again. The PR updates automatically.
   - ⚠️ **Pushing after an approval clears that approval** (the "dismiss stale reviews" rule). You'll
     need the reviewer to approve again. Batch your fixes to minimize round-trips.
3. **Merge.** Once you have ≥ 1 approval (and any checks are green), click **Merge pull request**
   (or `gh pr merge --squash`). Squash keeps the history tidy; any of the three methods is allowed.
4. **Delete the branch.** GitHub offers a **Delete branch** button after merge — safe to click; it
   only removes your feature branch, never `main`.
5. **Publish is automatic.** Merging to `main` fires the repo-dispatch pipeline. Your tutorial is
   live in a minute or two — see [writing-tutorials.md](writing-tutorials.md) §7.

---

## 7. Avoiding the "unattributed changes" extra-approval trap

The ruleset requires an **extra approval** when a commit's author can't be attributed to a GitHub
account. This almost always means your local git identity doesn't match your GitHub email. Fix it
once:

```bash
git config --global user.name  "Your Name"
git config --global user.email "your-github-email@example.com"   # must match a verified GitHub email
```

Use the email listed under **GitHub → Settings → Emails** (or your `@users.noreply.github.com`
address). If a PR already shows "unverified"/unattributed commits, re-committing with the correct
identity and re-pushing clears it; otherwise you'll simply need a second approver.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `! [remote rejected] main -> main (protected branch hook declined)` | You tried to push directly to `main`. | Push a **branch** instead (§4/§5) and open a PR. |
| `remote: Permission to sap-tutorials/<repo>.git denied` on `git push` | No write access to the repo. | Use the **fork** workflow (§5). |
| PR says **"Merging is blocked — review required"** | No approving review yet. | Request a reviewer (§6.1); your own approval doesn't count. |
| Your approval vanished after you pushed a fix | "Dismiss stale reviews on push" is on. | Re-request approval; batch changes next time. |
| PR wants a **second** approval unexpectedly | Commit is unattributed. | Fix git identity (§7); re-approval or a second approver clears it. |
| `git push --force` rejected | Force-push to a protected branch is blocked. | Don't force-push shared branches; if you must rewrite, do it on your **feature** branch before others pull it. |
| I'm a repo admin — can't I just bypass? | The ruleset has **no bypass list**. | No. Everyone uses PRs, including admins. |

---

## 9. FAQ

**Do I need this for the `-Contribution` (QA) repos too?**
The ruleset targets every repo's default branch in the org, so treat `*-Contribution` repos the same
way — branch/fork and PR. QA preview then works as described in
[writing-tutorials.md](writing-tutorials.md) §5.1.

**Can I still make quick typo fixes?**
Yes — the fastest path is the **web-UI edit** (§4.2). GitHub auto-creates the branch and PR for you;
you still need one approval.

**Who approves my PR?**
Your [repo group owner](repo-group-owners.md) is the default reviewer. For cross-cutting or platform
changes, ask in the platform team channel.

**Does the merge method matter?**
Not for the rules — merge, squash, and rebase are all allowed. **Squash** is recommended to keep one
clean commit per change.

**Where do I see the rule itself?**
[github.com/sap-tutorials/&lt;repo&gt;/rules](https://github.com/sap-tutorials) → the repo's
**Settings → Rules** (read-only for non-admins), or the branch-protection banner shown on a blocked
push.

---

## Reference: related docs

- [writing-tutorials.md](writing-tutorials.md) — authoring workflow, local preview, what happens after merge (§4 there now points here)
- [repo-group-owners.md](repo-group-owners.md) — for the people who review and approve your PRs
- [tutorial-repo-dispatch.yml](tutorial-repo-dispatch.yml) — the Action that triggers a rebuild once your PR is merged
- [GitHub Docs: About pull requests](https://docs.github.com/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
- [GitHub Docs: About rulesets](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
