# Design: durable approuter static serving (multi-instance convergence)

**Status:** proposal — for review
**Author:** drafted during the 2026-08-10/11 stale-static incident
**Related:** #1604 (island fingerprinting), #1628 (rebuild-content manifest fix), #1641 (rebuild guard), [build.md](build.md)

## Problem

The approuter serves the Hugo static site (homepage, `/browse/`, `/topics/`, `/devtoberfest/`, island JS/CSS, admin-UI SPA, etc.) from a **per-container local directory** (`approuter/static`, `STATIC_DIR` in `approuter/server.js`). Two mechanisms populate it:

1. **Deploy-time (durable):** `mbt build` bakes `hugo/public` into the approuter droplet. Every instance that stages from that droplet serves identical, correct static. Guarded by `scripts/deploy-mta.cjs` Step 2.5.
2. **Runtime push (ephemeral):** `POST /admin/rebuild` (`approuter/server.js:316`, mounted `:578`) gunzips an uploaded tarball into `static-new/` and **atomically renames it over the live `static/`** (`:373-374`). This is how `rebuild-content.yml` (modes `full` / `catalog-only`) and the debounced Admin-UI saves refresh content **without a redeploy** (~2–10 min vs. a full MTA deploy).

The runtime-push mechanism has two structural weaknesses:

### Weakness 1 — content correctness (ADDRESSED)
The pushed tarball is only as correct as the workflow that built it. The 2026-08-10/11 PROD outage was a tarball whose `index.html` referenced bare `/js/<name>.js` island paths (the workflow was missing `build:island-manifest`) that 404 post-#1604. **Fixed** by #1628 (add the manifest step) and #1641 (guard the runtime-push path, mirroring deploy Step 2.5). Documented here for completeness; not the subject of this proposal.

### Weakness 2 — multi-instance divergence (THIS PROPOSAL)
`POST /admin/rebuild` reaches **exactly one** approuter instance — whichever the CF router load-balances the request to. That instance swaps its local `static/`; **all other instances keep serving their previous tree.** Consequences:

- With `instances > 1` (prod autoscaler: min 1, CPU-scaled up to max — `.deploy/mta.yaml` `tutorials-autoscaler`), a rebuild leaves the fleet serving a **mix** of old and new static until the next full deploy.
- The push is **ephemeral**: a `cf restart` (or CF health/instance recycle, or autoscale-down-then-up) re-extracts the droplet and **discards** the pushed content — reverting to whatever was baked at the last deploy. So **`restart` is a recovery tool (revert to droplet), never a propagation tool.**
- **Autoscaled-up instances** start from the droplet, so a scale-up event *after* a push serves stale content on the new instance.

Currently latent (prod runs 1/1 most of the time), but it activates under load exactly when traffic is highest.

## Constraints

- **No object store** is entitled/bound today. Resources: HANA, XSUAA, destination, auditlog, cloud-logging, aicore, credstore, autoscaler, alert-notification.
- The approuter **already binds `srv-api`** (the CAP backend) and `tutorials-credstore`.
- The app already has **HANA** and a **WebSocket** channel (`@cap-js-community/websocket` on `/ws/*`); tutorial HTML is already served dynamically from HANA BLOBs via CAP.
- Content-refresh cadence must stay fast (no full redeploy per tutorial edit).

## Options

### Option A — instance-targeted fan-out (interim, contained)
Push the tarball to **every** instance using CF's `X-Cf-App-Instance: <app-guid>:<index>` routing header. The workflow queries the instance count (CF API) and loops the `POST /admin/rebuild` over each index.

- **Pros:** small change, isolated to `rebuild-content.yml` + the push step; no approuter code change.
- **Cons:** does **not** survive restart (still ephemeral); a scale-up *after* the push still serves droplet static on the new instance; needs live instance count at push time; brittle if autoscaler changes count mid-push.
- **Verdict:** a stopgap that narrows the steady-state window, not a durable fix.

### Option B — CAP/HANA-backed versioned bundle + approuter self-sync (RECOMMENDED)
Make the pushed bundle a **shared, versioned source of truth** in HANA (via the CAP backend the approuter already binds), and have **every instance converge to it**:

1. `/admin/rebuild` (or a new CAP endpoint) stores the uploaded bundle + a monotonic **version marker** in HANA (reuse the existing content-store BLOB pattern).
2. Each approuter instance, **on boot** and on a **version-change signal**, pulls the latest bundle from CAP and extracts it locally (same atomic-rename swap into `static/`).
3. The version-change signal can be a lightweight **poll** (every N s, compare version) or piggyback the existing **`/ws/*` WebSocket** to broadcast "new content vN".

- **Pros:** **restart-durable** (instances re-pull from HANA on boot) and **convergent** (all instances, including autoscaled-up ones, self-sync); reuses existing HANA + CAP + WS infra; no new entitlement.
- **Cons:** approuter code change (boot sync + poll/WS client); HANA stores the static bundle (size check — the bundle is larger than per-tutorial HTML; may warrant gzip + chunking or an object store, see C).
- **Verdict:** durable, architecturally consistent with how tutorials are already served.

### Option C — BTP Object Store (durable, needs entitlement)
Same self-sync shape as B, but the shared store is a BTP **Object Store** (S3-compatible) bound to the approuter, instead of HANA.

- **Pros:** purpose-built for blobs; keeps large static bundles out of HANA.
- **Cons:** requires an entitlement + service instance + binding (new infra + cost + subaccount quota); more moving parts than reusing HANA.
- **Verdict:** preferred over B **only if** bundle size makes HANA storage awkward.

### Option D — eliminate runtime push (rejected)
Bake all static in the droplet; require a full MTA deploy for any content change.

- **Cons:** content edits go from ~2 min to ~10 min deploy; defeats the fast-rebuild cadence the whole `/admin/rebuild` mechanism exists to provide. **Rejected.**

## Recommendation

**Option B**, phased:

- **Phase 0 (done):** #1628 + #1641 — correct bundle contents + guard. Removes the *outage* class.
- **Phase 1 (optional, fast):** Option A instance-targeted fan-out — narrows the steady-state divergence window while Phase 2 is built. Skip if Phase 2 lands soon.
- **Phase 2 (durable):** Option B — CAP/HANA-backed versioned bundle + approuter boot-sync + version poll (or WS). Decide B-vs-C on measured bundle size.

## Risks & rollback
- **Boot-sync failure isolation:** if an instance can't reach CAP on boot, it must fall back to the droplet static (fail-open) and retry — never crash-loop. Mirror the fail-open posture used across the KG jobs.
- **Version skew during rollout:** a mixed fleet (old approuter without self-sync + new) is exactly today's behavior, so Phase 2 is safe to roll incrementally.
- **Rollback:** Phase 2 is additive; disabling the self-sync client reverts to today's push-to-one-instance behavior (Phase 0 guards still apply).

## Open questions for review
1. Measured size of a full static bundle → decides **B (HANA)** vs **C (object store)**.
2. Is Phase 1 (fan-out) worth it, or go straight to Phase 2?
3. Poll interval vs. WS push for the version signal (WS is lower-latency but couples the approuter to the CAP WS).
