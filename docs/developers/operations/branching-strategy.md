# Branching Strategy

**Two long-lived branches: `DEV` (integration → DEV CF) and `main` (release →
PROD).** Feature work merges to `DEV`; a consolidated release PR promotes `DEV`
to `main` only when we're ready to transport to PROD. `main` carries the full
branch protection required by the SAP Open Source repo linter
([#1634](https://github.com/sap-tutorials/tutorials-ims/issues/1634), rule
`rl-branch_protection`).

> **Why this exists.** After go-live (PROD 2026-08-09) `main` needed protection
> to satisfy `rl-branch_protection`, and we wanted a staging boundary so DEV CF
> deploys don't require touching the PROD-facing branch. This model gives both:
> a fast, lightly-gated integration branch and a protected release branch.

---

## TL;DR

| | `DEV` | `main` |
|---|---|---|
| Represents | DEV CF | PROD |
| GitHub default branch | no | **yes** (so protecting it satisfies #1634) |
| Feature PRs target it | **yes** | no |
| Protection | force-push + deletion blocked | full #1634 set (see below) |
| Deploy | `deploy.yml` / `npm run deploy --env dev` | `--env prod` |

```
feature/* ──PR (squash)──▶ DEV ──deploy──▶ DEV CF
                            │
                            └──release PR (merge commit)──▶ main ──deploy──▶ PROD
hotfix/*  ──PR (admin-bypass)──▶ main ──deploy──▶ PROD ──back-merge──▶ DEV
```

---

## The three flows

### Feature
1. Branch from `DEV`: `git fetch origin && git switch -c feat/<topic> origin/DEV`.
2. Open a PR **targeting `DEV`** (change the base — the repo default is `main`).
3. Cheap CI runs automatically: `unit-tests` (in-memory SQLite) plus the
   path-filtered guards (`cds-build-staging-check`, `srv-qa-cp-list-check`,
   `schema-drift-check`, …). These are advisory on `DEV` — nothing is a
   *required* status check there.
4. **Squash-merge** into `DEV`. The branch auto-deletes on merge.
5. Deploy `DEV` to DEV CF when you want (`npm run deploy -- --env dev`).

### Release (DEV → main)
1. Open a **consolidated release PR** `DEV → main` when a batch is ready for
   PROD.
2. Use a **merge commit** (not squash). This keeps `DEV` an ancestor of `main`
   so the two never permanently diverge — a squash here would make `DEV` show as
   "unmerged" forever and the next release PR would replay the whole diff.
3. `main` protection requires 1 approval + conversation resolution. Solo
   maintainers merge via **admin bypass** (see below).
4. Deploy `main` to PROD (`npm run deploy -- --env prod`) — follow the
   [Deploy Checklist](./deploy-checklist.md).

### Hotfix (urgent PROD fix)
1. Branch from `main`: `git switch -c hotfix/<topic> origin/main`.
2. PR **targeting `main`**, admin-bypass the approval, deploy PROD.
3. **Back-merge `main → DEV`** immediately so `DEV` picks up the fix and doesn't
   regress it at the next release:
   ```bash
   git fetch origin
   git switch -c sync/main-to-dev origin/DEV
   git merge origin/main        # resolve, then PR sync/main-to-dev → DEV
   ```
   Back-merge is only needed after a hotfix — a normal release PR already leaves
   `DEV` an ancestor of `main`.

---

## `main` protection (classic branch protection)

Configured to satisfy every control `rl-branch_protection` mandates on the
default branch:

| Control | Setting |
|---|---|
| Require a pull request before merging | ✅ |
| Required approvals | 1 |
| Dismiss stale approvals on new commits | ✅ |
| Require review of the most recent push | ✅ |
| Require conversation resolution | ✅ |
| Block force-pushes | ✅ |
| Restrict deletions | ✅ |
| Required status checks | none (approval-only) |
| Enforce for administrators | **off** — admins bypass |

**Admin bypass.** `enforce_admins` is off so a solo maintainer can merge their
own release/hotfix PRs. The approval control is still *configured* (which is
what the linter checks), just bypassable by repository admins. If the linter is
ever tightened to also require enforce-for-admins, the only compliant options
are a real second reviewer (designated reviewer via `CODEOWNERS`, or a bot
approver).

Inspect or re-apply:
```bash
gh api repos/sap-tutorials/tutorials-ims/branches/main/protection
```

## `DEV` protection

Force-pushes and deletions blocked; **no** PR/approval requirement so
integration stays fast.

---

## CI wiring

- `unit-tests`, `secret-scan`, `no-committed-secrets-check` run on `pull_request`
  (any base) **and** on push to `main` **and** `DEV`.
- Heavy suites (`smoke`, `e2e`, `load-test`) run post-deploy or on a schedule —
  never on PRs, so `DEV` PRs stay fast.
- `docs-deploy` publishes this docs site on **push to `main`** only. A doc
  change merged to `DEV` therefore goes live only after the next release PR
  reaches `main`.

## Repo hygiene

`delete_branch_on_merge` is **on** — merged PR branches auto-delete, preventing
the stale-branch buildup we cleaned up when adopting this model. Keep
long-lived branches to `DEV` and `main` only.
