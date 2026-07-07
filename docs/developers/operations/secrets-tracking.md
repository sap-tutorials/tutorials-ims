# Secrets tracking — operations runbook

**Spec:** [docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md](../../superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md)

**Issue:** [#464](https://github.com/sap-tutorials/tutorials-ims/issues/464)

## What

The `Secrets` HANA entity tracks **credential metadata only** — `key`, `description`, `kind`, `rotationOwner`, `rotationDocsUrl`, `expiresAt`, `lastRotatedAt`. It does NOT store credential values. Values stay in CF env / mtaext / GitHub Actions secrets / managed services. Phase 2-C (#465) will add encrypted-value storage once the encryption-key management decision is made.

A daily cron at 04:11 UTC computes `daysRemaining` per row and surfaces warnings via the admin-shell notifications popover (bell icon, top-right of `/admin-ui/`).

## How to add a new tracked secret

Two paths converge on the same DB row:

**Path A — via the admin tile (preferred for ad-hoc additions):**

1. Open `/admin-ui/#secrets`.
2. Click **Add**.
3. Fill in `Key` (env-var name), `Description`, `Kind` (dropdown), `Rotation Owner` (email), `Rotation Docs URL`, `Expires At`, `Last Rotated At`.
4. Click **Save**.

**Path B — via the seed script (preferred when adding multiple secrets, or when DB is fresh):**

1. Edit `scripts/seed-secrets.cjs` and add a new entry to the `INITIAL_SECRETS` array.
2. Run: `npx cds bind --exec -- node scripts/seed-secrets.cjs`
3. The script is idempotent on `key` — existing rows are not touched.

**Path C — updating metadata for an EXISTING row** (e.g. a runtime contract change makes the description stale, [#796](https://github.com/sap-tutorials/tutorials-ims/issues/796)):

1. Edit the entry in `scripts/seed-secrets.cjs`.
2. Run `npx cds bind --exec -- node scripts/seed-secrets.cjs` (no flags) — the dry-run output surfaces metadata drift between this file and the DB row.
3. Re-run with `--commit --sync-metadata --keys KEY1[,KEY2]` to overwrite the listed rows' description / kind / rotationOwner / rotationDocsUrl. **Values + lastRotatedAt + expiresAt are NEVER touched.** Use `--keys` to scope the patch and avoid trampling unrelated admin-UI edits on other rows.

Run against each environment (`cf target -s dev`, `cf target -s qa`, `cf target -s prod`) followed by `npx cds bind` to re-bind, then the seed-secrets command above.

## How rotation owners receive warnings

- **Bell icon notifications popover** in `/admin-ui/`. Live query on every open. Shows secrets with `daysRemaining ≤ 14` **and** any row whose credstore value is missing (surfaces as CRITICAL with `reason: 'missing-value'` — [#1018](https://github.com/sap-tutorials/tutorials-ims/issues/1018)).
- **Severity tiers:**
  - 🔴 **CRITICAL** — `daysRemaining ≤ 0` (expired or expires today) **or** value missing from credstore
  - 🟡 **WARNING** — `1 ≤ daysRemaining ≤ 7`
  - 🔵 **INFO** — `8 ≤ daysRemaining ≤ 14`
  - silent — `daysRemaining > 14` or `expiresAt = null` **and** credstore has a value

- **`/admin-ui/#secrets` List Report `Value` column** ([#1018](https://github.com/sap-tutorials/tutorials-ims/issues/1018)) — every row displays a badge: **🟢 Present** when credstore returns a non-null value, **🔴 Missing** when credstore returns null / transport error. Distinguishes "HANA row exists" from "credential actually retrievable" at a glance.

- **Daily PipelineLog row** at 04:11 UTC capturing `{total, critical, warning, info, missingValues, criticalKeys}`.
  - View at `/admin-ui/#pipelinelog` (filter by `jobName = secret-expiry-check`).

Phase 3+ may add external notifiers (GitHub-issue-comment poster, email via mail-client.js). Out of scope for #464.

## `kind` enum values

| Kind | Examples |
|---|---|
| `github-pat` | GitHub PAT (DISPATCH_TOKEN, TUTORIALS_GITHUB_TOKEN) |
| `content-api-key` | Bearer token for `/content/publish` |
| `salt` | Hash salt (SUBMISSION_SALT_SECRET) |
| `smtp-credential` | SMTP credentials |
| `service-key` | BTP service key (AI_AUTHOR_AICORE_SERVICE_KEY) |
| `other` | Fallback |

## After rotating a secret

1. Update the **actual** credential per its rotation runbook (e.g. mint a new GitHub PAT, push it to CF env or GH Actions secret, redeploy).
2. In `/admin-ui/#secrets`, find the row, click Edit, update `Last Rotated At` and (if it's a vendor-defined cadence like 90-day GitHub PATs) update `Expires At` to `today + 90 days`.
3. The popover entry will disappear within 24 hours (next cron tick) — or immediately on next popover open if `daysRemaining` is now > 14.

## Cross-links

- Research-design parent: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../../superpowers/specs/2026-06-20-runtime-config-research-design.md)
- Phase 2-A foundation (already shipped): #463 / PR #471
- Phase 2-C encrypted values (gated): #465
- Phase 3 long-tail env-var migration: #466
- GitHub PAT rotation runbook: [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)

---

## Bootstrap: GITHUB_DISPATCH_TOKEN (#429)

Admin writes to Missions/Groups/CompletionPaths/Tutorials/Steps/Tags/etc.
dispatch a debounced `rebuild-content.yml` workflow run after a 60s quiet
window. The dispatch is gated on a PAT stored in BTP Credential Store. To
enable post-admin-write auto-rebuild:

1. Generate a fine-scoped GitHub PAT with `workflow:write` only.
   See [github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)
   for the rotation runbook.
2. In the admin Secrets UI (`/admin-ui/#secrets-display`), click "Create"
   and add a row with:
   - `key = GITHUB_DISPATCH_TOKEN`
   - `kind = pat`
   - `rotationOwner = <your email>`
   - `description = GitHub PAT for rebuild-content.yml workflow_dispatch (#429)`
3. Click into the new row, then **Set Value** — paste the PAT.
4. Verify: make a small admin edit to a Mission and watch the
   `rebuild-content` Actions tab. Within 60-90s a new run should appear
   with `trigger-source: admin-write` and `mode: catalog-only`.

### What happens without the token

If the secret is unset, `scheduleRebuild` silently no-ops on production
and falls back to `process.env.GITHUB_DISPATCH_TOKEN` in local dev
(useful for unit tests). The next admin save tries again, so there's no
permanent stale state — just no auto-rebuild until the secret is set.

### Rotation

The credstore-backed read is cached for 5 minutes in-memory on each
tutorials-srv instance. **Admin Secrets UI write handlers (setSecretValue,
rotateSecretValue, clearSecretValue) call an invalidator immediately when
the row's `key === 'GITHUB_DISPATCH_TOKEN'`, so a rotation via the UI
takes effect on the next dispatch with near-zero lag — no restart
needed.** The 5-min TTL is the upper bound when the cache flushes via
other paths (e.g. a manual credstore CLI write).

### Mode classification

The dispatched workflow runs in one of three modes depending on what the
admin saved:

| Entity / action | Mode | Wall clock |
|---|---|---|
| Missions / Groups / CompletionPaths / CompletionPathItems / GroupPathItems / FeaturedTasks | catalog-only | 30-60s |
| Tutorials (single row) | slug-targeted | 30-60s |
| Steps (resolves to parent tutorial slug) | slug-targeted (fallback: full) | 30-60s |
| Tags | full + force-cap-refetch | 3-5 min |
| Bound action: classifyCategories, setFeaturedOrder | catalog-only | 30-60s |
| Bound action: commitTagImport, cleanupUnusedTags | full + force-cap-refetch | 3-5 min |

Mode classifier: `srv/lib/_classify-rebuild-mode.js`.

---

## Pre-flight before removing a fallback path (#1018)

**MUST run this checklist before merging a PR that removes an env-var fallback for a credstore-fronted secret** (any of `CONTENT_API_KEY`, `GITHUB_DISPATCH_TOKEN`, `SMTP_*`, `TUTORIALS_GITHUB_TOKEN`, `SUBMISSION_SALT_SECRET`, `YOUTUBE_API_KEY` — the full tracked list is queryable at `/admin-ui/#secrets`).

Background: on **2026-07-06** the `rebuild-content` workflow started failing with `HTTP 503: Content API not configured`. Root cause was that `CONTENT_API_KEY`'s credstore entry had never actually landed — a Save via `/admin-ui/#secrets` during the 2026-06-23 mTLS/JWE binding transition returned 2xx but silently dropped the write. The `process.env.CONTENT_API_KEY` fallback (injected by envsubst pre-#980) had been masking the miss. PR #980 stripped the envsubst plumbing, and the next `cf deploy` after that unmasked the miss → every publish 503'd. See the [#1018 issue body](https://github.com/sap-tutorials/tutorials-ims/issues/1018) for the reconstructed timeline.

The pre-flight check in #980's spec relied on the admin UI showing the row (which it did — the HANA metadata row was there) rather than proving the credstore *value* was retrievable. **That check was insufficient.** The HANA row's presence does NOT prove credstore has a value.

### Pre-flight steps

For **every** alias whose env-var fallback the PR removes:

1. **Round-trip read from credstore.** Call `revealSecretValue` on the row from `/admin-ui/#secrets`. If the reveal dialog shows a value (any non-empty plaintext), the credstore has the value. If it 404s or the value is empty, **stop** — the credstore is empty and the fallback removal will break the runtime path. Set the value via `/admin-ui/#secrets` Set Value first.

2. **Functional 400/403/503 curl on a live endpoint.** From your machine, hit the endpoint that consumes the secret with the correct Bearer token. For `CONTENT_API_KEY`:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -X POST \
     -H "Authorization: Bearer $CONTENT_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{}' \
     "$SRV_URL/content/publish/begin"
   ```

   Expected: **400** (server accepted the Bearer, rejected the empty payload). If **503**: credstore returned null → fallback removal will break the runtime path. If **401/403**: your local `CONTENT_API_KEY` env var doesn't match the credstore value — one of them is stale.

3. **Paste written proof into the PR body.** Include:
   - The `revealSecretValue` output preview (redact the value; just note "value present, N chars").
   - The exact curl command + response code.

   A reviewer can then trust that the fallback removal is safe without re-running the check themselves.

### Automated guardrails (already in place)

Guards installed by [#1018](https://github.com/sap-tutorials/tutorials-ims/issues/1018) mean this manual check is defense-in-depth, not the last line:

- **Read-back verify** in `setSecretValue` / `rotateSecretValue` — an admin-UI Save now performs an immediate `readSecret` after the write and rejects the operation with 500 if the readback value doesn't match. Fails loudly instead of silently.
- **Daily presence probe cron** at 04:11 UTC — every tracked row's credstore value is probed; missing values surface as CRITICAL in the notifications popover.
- **`hasValue` badge** in the `/admin-ui/#secrets` List Report — a missing value shows as a red "Missing" badge next to the row.
- **Post-deploy publish-endpoint smoke** in `.github/workflows/deploy.yml` — after `cf deploy` succeeds, the workflow POSTs `/content/publish/begin` with the CI-side `CONTENT_API_KEY` as Bearer and expects a 400. A 503 fails the deploy job.

Even with all four in place, the pre-flight above is still cheap and cuts the "silent drift" window from "hours until the next rebuild" to "seconds during code review".
