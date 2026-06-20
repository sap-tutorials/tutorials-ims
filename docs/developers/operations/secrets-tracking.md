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
