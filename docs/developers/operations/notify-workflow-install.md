# Installing the notify → rebuild workflows

> **Audience:** the `tutorials-ims` maintainer. This doc covers how the two
> "notify" workflows get installed into the org's other repos, how to add
> them to newly-created repos, and how the installer stays safe to re-run.

## What these workflows do

Two workflows in *other* `sap-tutorials` repos fire `repository_dispatch` at
`tutorials-ims` to trigger content rebuilds:

| Workflow (in the other repo) | Installed into | Fires event | Consumed by |
| --- | --- | --- | --- |
| `.github/workflows/notify-tutorials-ims.yml` | every **tutorial source repo** | `tutorial-updated` | `rebuild-content.yml` (PROD content) |
| `.github/workflows/notify-qa.yml` | every **`*-Contribution` repo** | `tutorial-qa-updated` | `rebuild-content-qa.yml` (QA preview) |

Templates (source of truth, edit these):
- PROD: [`docs/authors/tutorial-repo-dispatch.yml`](../../authors/tutorial-repo-dispatch.yml)
- QA: [`.github/workflows/notify-qa.yml.template`](../../../.github/workflows/notify-qa.yml.template)

Both authenticate via the `sap-tutorials-builder` GitHub App (installation
token) with a classic-PAT fallback — see [github-app-setup.md](github-app-setup.md).

## The installer

`scripts/install-notify-workflows.ts` (`npm run install-notify-workflows`)
discovers the org's repos live, classifies them (source vs `*-Contribution`),
and installs the right template into each.

### It is idempotent — safe to re-run any time

For each repo it GETs the existing workflow file and content-compares
(trailing-whitespace-insensitive) against the rendered template:

| Existing state | Action |
| --- | --- |
| file absent | **install** (create on default branch) |
| identical to template | **skip** — no write |
| differs from template | **update** (overwrite with prior sha) |

Re-running when everything is current commits **nothing**. So it's the single
command to run both for the first rollout and whenever repos are added or a
template changes.

### It is safe by default (dry-run)

```bash
npm run install-notify-workflows              # DRY-RUN: reports per-repo decision, writes nothing
npm run install-notify-workflows -- --execute # commits directly to each repo's default branch
npm run install-notify-workflows -- --only qa     # only the QA / *-Contribution set
npm run install-notify-workflows -- --only prod   # only the PROD / source-repo set
```

Auth: set `GITHUB_TOKEN` (or `TUTORIALS_GITHUB_TOKEN`) to a token with
**Contents: write** on the target repos. The App private key isn't used here —
this is an operator-run script; a PAT or `gh auth token` is simplest. Apply
mechanism is a **direct commit to the default branch** (no PR), per the #1154
rollout decision — merge-to-main on the *source* content is the review gate;
these notify workflows are infrastructure.

## Adding the workflow to a NEW repo

Nothing special — discovery is live. When a new tutorial source repo or
`*-Contribution` repo is created:

```bash
npm run install-notify-workflows                 # dry-run: confirm the new repo shows "would-install"
npm run install-notify-workflows -- --execute    # install it (existing repos skip as no-ops)
```

The new repo is picked up automatically because the installer lists the org
every run. Repos named in `EXCLUDED_REPOS` (`tutorials-ims`, `sandbox`,
`sandbox-Contribution`) are always skipped; archived / disabled / fork repos
are ignored.

> **Enabling App auth per repo:** after the workflow file lands, set the repo
> variable `USE_GITHUB_APP=true` and add the `TUTORIALS_APP_ID` +
> `TUTORIALS_APP_PRIVATE_KEY` Actions secrets so the notify workflow mints an
> App token instead of the PAT fallback. Until then it uses the legacy PAT
> (`TUTORIALS_DISPATCH_TOKEN` for source repos, `TUTORIALS_POC_DISPATCH_TOKEN`
> for Contribution repos).

## Environment routing (source repos)

The PROD template sends `client_payload.environment` (default `prod`, override
per-repo via a `REBUILD_ENVIRONMENT` repo variable). `rebuild-content.yml`
validates it against `dev|qa|prod` and defaults to `dev` when absent. A push to
a source repo's `main` therefore rebuilds the configured environment — branch
protection on that repo is the publish gate; no additional approval is layered
on (deliberate — see the "Trust model" comment in `rebuild-content.yml`).

## Future: scheduling

Currently the installer is run manually. If drift becomes a maintenance burden,
wrap it in a scheduled GitHub Actions workflow (weekly `--execute`) so new
repos are covered without anyone remembering. Not done yet — YAGNI until the
repo set churns enough to justify it.
