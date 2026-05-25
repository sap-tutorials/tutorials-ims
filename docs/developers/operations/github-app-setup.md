# GitHub App Setup — `sap-tutorials-builder`

> **Audience:** the SAP GitHub org admin who owns `https://github.com/sap-tutorials`, and the `tutorials-poc` repo maintainer who will set the Actions secrets and flip the activation variable. This doc is intentionally short and copy-pasteable.

For the *why* behind this change, see [`github-app-migration.md`](../../historic/github-app-migration.md). The short version: replace a long-lived classic PAT (which expires under SAP rotation policy and is tied to one human) with a GitHub App that mints a fresh 1-hour token per workflow run.

## What this changes operationally

- Today: `tutorials-poc` runs `npm run fetch-tutorials` in CI using the `TUTORIALS_GITHUB_TOKEN` secret (a classic PAT). When the PAT expires, the build breaks until someone with access regenerates and re-pastes it.
- After: the workflow asks GitHub for a short-lived installation token at the start of each run. Nothing to rotate.

## What's already in the repo

The workflow change is already merged (see `.github/workflows/rebuild-content.yml`):

- A `Generate GitHub App token` step gated on the **repo variable** `USE_GITHUB_APP == 'true'`.
- The `Fetch tutorials` step picks `steps.app-token.outputs.token || secrets.TUTORIALS_GITHUB_TOKEN`.

So:
- Until the org admin completes setup → the variable stays unset → step is skipped → PAT continues to be used.
- Once secrets + variable are in place → App token is used automatically.
- To roll back at any time → set the variable to anything other than `true` (or delete it).

No code changes required in `scripts/parsers/github.ts`. Installation tokens are standard Bearer tokens.

---

## Part 1 — Org admin steps (sap-tutorials)

These run once. Estimated time: 15 minutes.

### 1.1 Register the App

1. Go to **https://github.com/organizations/sap-tutorials/settings/apps/new**
2. Fill in:
   - **GitHub App name:** `sap-tutorials-builder`
   - **Homepage URL:** `https://github.com/sap-tutorials/tutorials-poc` (or wherever the repo lives)
   - **Webhook → Active:** **uncheck** (we don't consume events)
   - **Repository permissions:**
     - `Contents`: **Read-only**
     - `Metadata`: **Read-only** (auto-selected)
     - everything else: **No access**
   - **Organization permissions:** all No access
   - **Account permissions:** all No access
   - **Where can this GitHub App be installed?** Only on this account
3. Click **Create GitHub App**.

### 1.2 Generate a private key

On the App's settings page, scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads automatically. **Save this file** — you'll paste its contents into a repo secret in Part 2. The key cannot be recovered later; if lost, generate a new one and rotate.

### 1.3 Note the App ID

At the top of the App's settings page: **App ID:** `XXXXXXX`. Copy this number.

### 1.4 Install the App on the org

1. On the App settings page, left sidebar → **Install App**.
2. Click **Install** next to `sap-tutorials`.
3. Choose either:
   - **All repositories** (simpler; covers public tutorials + private `*-Contribution` repos automatically as new ones are added), **or**
   - **Only select repositories** → pick every public tutorial repo plus every `*-Contribution` private repo.
4. Click **Install**.
5. After installation, the URL contains `/installations/<INSTALLATION_ID>`. Copy this number.

### 1.5 Hand off to the repo maintainer

Send to whoever owns `tutorials-poc` Actions secrets:

- **App ID** (the number from 1.3)
- **The full contents of the `.pem` file** from 1.2 — paste between `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` inclusive
- **Installation ID** (the number from 1.4)

Use a secure channel (e.g. SAP password vault, encrypted email, in-person). Treat the private key like any other credential — anyone with it can mint tokens with the App's permissions.

---

## Part 2 — Repo maintainer steps (tutorials-poc)

These also run once, after Part 1 is complete. Estimated time: 5 minutes.

### 2.1 Add three Actions secrets

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`. Add:

| Name | Value |
|---|---|
| `TUTORIALS_APP_ID` | App ID from 1.3 |
| `TUTORIALS_APP_PRIVATE_KEY` | Full `.pem` contents from 1.2 (including BEGIN/END lines) |
| `TUTORIALS_APP_INSTALLATION_ID` | Installation ID from 1.4 *(optional — see note)* |

> The `actions/create-github-app-token@v1` action can resolve the installation ID from `app-id + owner` automatically. The current workflow does **not** pass `installation-id`, so this secret is optional. Add it only if you later want to pin a specific installation.

### 2.2 Flip the activation switch

Same page, **Variables** tab → **New repository variable**:

| Name | Value |
|---|---|
| `USE_GITHUB_APP` | `true` |

This is a non-secret variable on purpose — it's a feature flag, not a credential, and being non-secret means it shows up clearly in workflow logs.

### 2.3 Verify with a manual run

1. Go to **Actions** → **Rebuild Content** → **Run workflow**.
2. Choose `dev`, leave `slug` empty.
3. Watch the run. You should see:
   - `Generate GitHub App token` step: ✅ **runs** (was previously skipped)
   - `Fetch tutorials` step: ✅ uses the App token (no observable difference in output)
4. If the run succeeds end-to-end, the migration is complete.

### 2.4 Cleanup (after one successful unattended run)

Once you've confirmed at least one scheduled or dispatch-triggered run works without manual help:

1. Delete the `TUTORIALS_GITHUB_TOKEN` repo secret.
2. Revoke the underlying classic PAT in the source account's developer settings (so it can't be used elsewhere by accident).

> Keep the `TUTORIALS_GITHUB_TOKEN` secret for at least one full successful run cycle before deleting. It's the rollback path if the App turns out to have a permission gap.

---

## Rollback

If anything misbehaves after activation:

1. Set `USE_GITHUB_APP` repo variable to `false` (or delete it).
2. Re-add `TUTORIALS_GITHUB_TOKEN` secret if it was already deleted.
3. Re-run the workflow. It falls back to the PAT path automatically.

No code change needed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Resource not accessible by integration` on a `*-Contribution` repo | App not installed on that repo | Re-run install (1.4), pick "All repositories" or add the missing repo to the selected list |
| `Bad credentials` on GraphQL | Private key pasted incorrectly (missing BEGIN/END lines, line endings mangled) | Re-paste the `.pem` exactly as downloaded; GitHub's secret editor preserves newlines correctly when pasted whole |
| `app-token` step is skipped even after activation | `USE_GITHUB_APP` variable name typo, or value is not exactly `true` | The check is `vars.USE_GITHUB_APP == 'true'` — must be lowercase string |
| Rate limit errors after migration | App installation rate limit (5000 req/hr) shared with other workflows | Unlikely with current build cadence; check if other workflows now use the same install |

## References

- [`github-app-migration.md`](../../historic/github-app-migration.md) — engineering rationale, current state analysis, comparison table
- [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) — the GitHub-published action used in the workflow
- [GitHub Apps documentation](https://docs.github.com/en/apps/creating-github-apps)
