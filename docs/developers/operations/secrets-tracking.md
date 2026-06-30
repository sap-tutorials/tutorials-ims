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

- **Bell icon notifications popover** in `/admin-ui/`. Live query on every open. Shows secrets with `daysRemaining ≤ 14`.
- **Severity tiers:**
  - 🔴 **CRITICAL** — `daysRemaining ≤ 0` (expired or expires today)
  - 🟡 **WARNING** — `1 ≤ daysRemaining ≤ 7`
  - 🔵 **INFO** — `8 ≤ daysRemaining ≤ 14`
  - silent — `daysRemaining > 14` or `expiresAt = null`

- **Daily PipelineLog row** at 04:11 UTC capturing `{total, critical, warning, info, criticalKeys}`.
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
