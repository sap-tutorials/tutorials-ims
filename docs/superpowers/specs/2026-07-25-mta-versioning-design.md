# MTA Versioning via `git describe`

**Date:** 2026-07-25
**Status:** Approved (design), pending implementation plan
**MTA:** `tutorials-ims` (repo: `tutorials-poc`)

## Problem

Now that we are live in PROD across three environments (dev / qa / prod), we need
to see **exactly which version is deployed in each environment**, and trace any
deployed build back to the commit it was built from.

Today the deploy pipeline (`.github/workflows/deploy.yml`, "Set version" step)
computes `1.0.<github.run_number>` and `sed`s it into `mta.yaml` at deploy time.
Gaps:

- `1.0.<run_number>` is a **shared running counter** across all runs and all
  environments. It carries no meaning — you cannot tell what code is in prod
  `1.0.412` vs qa `1.0.437`, nor what differs between them.
- The version is injected ephemerally and discarded — nothing is committed,
  tagged, or recorded per environment.
- To discover what is live you must dig through Actions run history.

## Goal

A **meaningful, traceable** MTA version, surfaced four ways (all reading one
source of truth):

1. **Query the platform** — `cf mtas` / `cf apps` show the real version.
2. **Release history** — semver git tags mark releases; deployed versions trace
   back to a commit.
3. **`/version` endpoint** — the running `srv` app exposes its version + git SHA.
4. **Tracking file** — a committed `DEPLOYED.md` shows env → version → SHA →
   timestamp at a glance.

## Load-bearing constraint

The MTA `version:` field **must be valid semver** (`MAJOR.MINOR.PATCH`
optionally followed by a `-prerelease` suffix), per the MTA spec and confirmed
against CAP docs. The repo's only existing tag, `recommendations-v1-shipped`, is
**not** semver, so raw `git describe` output
(`recommendations-v1-shipped-2498-g203c4161`) cannot feed the MTA version
directly. The design bridges this with a semver tag convention + a normalization
step.

## Design

### 1. Version scheme & tag discipline

Adopt semver release tags of the form `vMAJOR.MINOR.PATCH` (e.g. `v1.0.0`).
The pipeline computes the version with:

```bash
git describe --tags --match 'v*' --always
```

| Situation | `git describe` output | Normalized MTA version |
|---|---|---|
| HEAD is exactly at a tag | `v1.4.2` | `1.4.2` |
| HEAD is N commits past last tag | `v1.4.2-5-ga7518452` | `1.4.2-5-ga7518452` |
| No matching `v*` tag reachable | `a7518452` (abbrev SHA) | `0.0.0-g<sha>` (safe fallback) |

- The leading `v` is stripped to satisfy the MTA semver requirement.
- The `-N-g<sha>` suffix is valid semver **prerelease** metadata and is the
  built-in "this environment is ahead of the last release" signal — exactly the
  delta we want to see between prod and qa.
- The fallback guarantees CI never hard-fails on a missing tag.

**Normalization rule** (single helper, used by the pipeline): take
`git describe --tags --match 'v*' --always`, and if the result begins with `v`
followed by a digit, strip the leading `v`; otherwise (bare SHA fallback) emit
`0.0.0-g<result>`.

**Required CI fixes** for `git describe` to work:

- `actions/checkout` must set `fetch-depth: 0` **and** `fetch-tags: true`. The
  default shallow clone has no tags, so `git describe` would fail.
- Create an initial `v1.0.0` tag on the current prod commit so the first
  computed version is meaningful (`1.0.0`, not the fallback).

**Replaces** the existing `Set version` step. Same mechanism (compute a value,
`sed` it into `mta.yaml` before `mbt build`); the value becomes meaningful.

### 2. The four inspection surfaces

All four read the **same computed version** from §1.

| Surface | Mechanism | New work |
|---|---|---|
| **CF query** | `cf mtas` / `cf apps` display the meaningful MTA version | None — free once §1 lands |
| **`/version` endpoint** | Pipeline writes `srv/version.json` (`{version, gitSha, environment, builtAt}`) before `mbt build`. `srv` serves it at `GET /version` via a `cds.on('bootstrap', …)` express route. Unauthenticated; exposes only non-sensitive build metadata (version, short SHA, env name, build timestamp). | srv bootstrap route + pipeline write step |
| **Release history** | `v*` semver tags mark human-created releases; `git describe` consumes them | Tag discipline (releases tagged by humans) |
| **Tracking file** | On every **successful** deploy, the pipeline updates `DEPLOYED.md` with a row per environment (env → version → gitSha → timestamp → run URL) and commits it. The deploy job already has `contents: write`. | Pipeline commit step |

**Why both tags and `DEPLOYED.md`** (they are complementary, not redundant):

- Git tags = **release** history. Created by humans at release points; not moved
  on dev/qa deploys.
- `DEPLOYED.md` = **current per-environment state**. Updated on every deploy to
  any env, so it always answers "what is in dev/qa/prod *right now*".

### 3. `/version` endpoint contract

```
GET /version  →  200 application/json
{
  "version": "1.4.2-5-ga7518452",
  "gitSha": "a7518452",
  "environment": "prod",
  "builtAt": "2026-07-25T09:44:00Z"
}
```

- Served by the `srv` module (Node.js CAP app) via an express route registered
  on `cds.on('bootstrap')` in `srv/server.js`.
- `version.json` is written by the pipeline into the `srv` build context before
  `mbt build`, so it is packaged into the deployed archive.
- Local/dev fallback: if `version.json` is absent (e.g. `cds watch`), the route
  returns `{version: "dev", gitSha: "local", environment: "local", builtAt: null}`
  rather than erroring.
- Unauthenticated by design (build metadata only, no secrets). If policy later
  requires it, gating is a one-line change on the route.

### 4. Scope guard / promotion mechanics

Promotion mechanics are **unchanged**. Each environment deploys via a fresh
`mbt build` from the checked-out commit (current flow). Consequence:

- Deploy prod from the **tagged** commit → clean `1.4.2`.
- Deploy from HEAD (ahead of tag) → `1.4.2-N-gsha`, visibly marking drift.

This is the intended `git describe` behavior; no change to how deploys are
triggered (`workflow_dispatch` with an environment choice).

## Out of scope

- Automated semver bumping / release-please style automation. Release tags are
  created by humans for now.
- Changing the deploy trigger model or promotion between environments.
- Authenticating the `/version` endpoint (may revisit per policy).

## Files touched (anticipated)

- `.github/workflows/deploy.yml` — checkout fetch-depth/tags; replace "Set
  version" with `git describe` + normalization; write `srv/version.json`; commit
  `DEPLOYED.md` on success.
- `srv/server.js` — `GET /version` bootstrap route.
- `srv/version.json` — build artifact (written by CI; local fallback handled in
  code).
- `DEPLOYED.md` — new tracking file at repo root.
- Initial `v1.0.0` git tag on current prod commit (one-time, out-of-band).

## Cutover

One-time seed of the initial release tag (run by a human with push access,
against the commit currently live in prod — `203c4161` at time of writing):

    git tag -a v1.0.0 203c4161 -m "Initial versioned release (tutorials-ims)"
    git push origin v1.0.0

After this, a deploy from that commit computes MTA version `1.0.0`; deploys
from commits ahead of the tag compute `1.0.0-<N>-g<sha>`.
