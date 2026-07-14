# Deploy Checklist (definitive)

**One flow, followed the same way by a human or an AI agent.** The automated
path is `npm run deploy -- --env <dev|qa|prod>` (see
[`scripts/deploy-mta.cjs`](../../../scripts/deploy-mta.cjs)). This document is
the human-followable mirror of that script — the steps, guards, and their
*reasons* are identical. If the two ever drift, the script wins; fix this doc.

> **Why this exists.** On 2026-07-14 a local `.deploy` deploy shipped a broken
> `/explore/` page ("Explore bundle missing"). Root cause: `npm run build:all`
> was stale/skipped before `mbt build`, and — unlike CI — the local deploy path
> ran **no post-deploy smoke test**, so the regression shipped silently. The
> smoke test that catches it (`test/smoke/explore-route.smoke.test.js`) already
> existed; it just never ran locally. This checklist + `npm run deploy` close
> that gap for the whole class of "stale/incomplete build" bugs.

---

## TL;DR — the automated path

```bash
# From the PRIMARY checkout on main (never a worktree):
cf login -a https://api.cf.eu10-005.hana.ondemand.com   # if not already
cf target -s dev                                         # match the env
npm run deploy -- --env dev
```

`npm run deploy` runs every step below in order and **fails loudly** if any
guard trips. Flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print the plan, run read-only guards (cf target, branch), touch nothing. |
| `--skip-build` | Deploy an already-built mtar. Guards still run. Use only when you *just* built. |
| `--skip-smoke` | **Discouraged.** Skips post-deploy verification — this is exactly how `/explore` shipped broken. Prints the manual command to run instead. |

Exit codes: `0` success · `1` guard/build/deploy failure · `2` **smoke gate failed** (deploy landed but a check regressed — treat env as broken).

---

## The manual checklist (if not using `npm run deploy`)

Environment coordinates — the single source of truth (mirrored in
`scripts/deploy-mta.cjs` `ENVS` and in
[mta-deployment.md](mta-deployment.md#canonical-app-names-per-environment)):

| Env | Region | Space | Approuter URL | Srv URL |
| --- | --- | --- | --- | --- |
| dev | `eu10-005` | `dev` | `…-dev-tutorials-approuter.cfapps.eu10-005.…` | `…-dev-tutorials-srv.cfapps.eu10-005.…` |
| qa | `eu10-005` | `dev` | `…-qa-tutorials-approuter.cfapps.eu10-005.…` | `…-dev-tutorials-srv-qa.cfapps.eu10-005.…` |
| prod | `eu10-005` | `prod` | `…-prod-tutorials-approuter.cfapps.eu10-005.…` | `…-prod-tutorials-srv.cfapps.eu10-005.…` |

### ☐ Step 0 — Preconditions

- [ ] You are in the **primary checkout**, not a `.claude/worktrees/` tree.
      *(mbt only `cp`s `hugo/public/`; a worktree base can bake stale/ahead content.)*
- [ ] `git branch --show-current` → `main`.
- [ ] Deploy scope confirmed with the maintainer (backend-only / +content / +QA).

### ☐ Step 1 — cf target guard

- [ ] `cf target` API endpoint host contains the env's **region** (`eu10-005`).
      *(The 2026-07-14 trigger: cf was pointed at `us10` while the target is `eu10-005`.)*
- [ ] `cf target` **space** equals the env's space.
      Fix: `cf login -a https://api.cf.eu10-005.hana.ondemand.com` then `cf target -s <space>`.

### ☐ Step 2 — Build

- [ ] Export the env's `CAP_BASE_URL` (deployed srv, **not** localhost).
- [ ] `npm run build:deploy`  *(= `check-deploy-cap-target && build:all`)*.
      - `build:all` runs `build:explore` (Vite + manifest emit) **before**
        `build:hugo`, and `build:hugo` runs `check-explore-bundle-manifest.cjs`
        which **hard-fails** if `hugo/data/explore_bundle.json` is absent.
      - **A green `build:deploy` cannot reproduce the /explore incident.** The
        incident happened only because this step was skipped.

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run build:deploy
```

### ☐ Step 3 — Package (mbt build)

- [ ] `cd .deploy && mbt build`.
- [ ] **Verify a fresh mtar was produced** — check `mta_archives/*.mtar` mtime advanced.
      *(mbt can silently no-op with exit 0 if its Go binary was never unpacked.
      On Windows a SUCCESSFUL build can also end with a benign
      "could not remove Makefile" + EXIT=1 AFTER "the MTA archive generated at:".
      Trust the mtar mtime, not the exit code.)*
      If stale: `(cd node_modules/mbt && node install cloud-mta-build-tool)` then retry.

### ☐ Step 4 — Deploy

- [ ] `cf deploy mta_archives/*.mtar -e ../deploy/<env>.mtaext -f` (from `.deploy/`).

### ☐ Step 5 — Smoke gate (do NOT skip)

- [ ] Run the smoke suite against the just-deployed URLs:

```bash
SMOKE_BASE_URL="<approuter url>" SMOKE_SRV_URL="<srv url>" npm run test:smoke
```

- [ ] All green. A failure here means the deploy **landed but regressed** —
      treat the env as broken until triaged. This is the step that turns a
      silent-broken-prod into a loud failure.

---

## Notes

- **Content publish** (tutorial HTML → HANA BLOBs) is a *separate* flow — see
  [mta-deployment.md Step 3](mta-deployment.md#step-3-publish-tutorial-content-to-hana).
  This checklist covers the MTA (approuter + srv + db) deploy only.
- **CI already does all of this.** `.github/workflows/deploy.yml` builds explore
  → Hugo → mbt → deploy → `test:smoke`. This checklist brings the *local*
  `.deploy` path up to the same bar. Prefer CI when you can.
- **Why `.deploy/mta.yaml` doesn't just render Hugo inline** (which would make
  Step 2 unskippable): an inline Hugo render inside the MTA before-all hit the
  MTA build timeout (the approuter `cp` of ~527MB already runs 6-9 min; hence
  the 30m timeout override). So the local path copies a pre-built `hugo/public/`
  and depends on Step 2 having run — which is what `npm run deploy` enforces.
