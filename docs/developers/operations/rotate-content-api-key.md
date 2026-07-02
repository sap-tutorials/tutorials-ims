# Rotating `CONTENT_API_KEY` — runbook

The `CONTENT_API_KEY` bearer token gates `POST /content/publish` and `POST /content/rollback` on the CAP srv. It's the only credential that can replace tutorial HTML in HANA, so any suspected exposure requires immediate rotation.

Filed as #887. This runbook is the rotation half; the code fix (placeholder in `deploy/dev.mtaext`, docs scrub, `.gitleaks.toml` guard) is already merged in the same PR.

## When to rotate

- Anyone unauthorized has had shell access to a CF app or a developer workstation with the key exported.
- The key has been printed to any log, ticket, chat, or email that isn't access-controlled.
- Time-based: **every 90 days as routine hygiene**.
- Immediately if a secret-scanning alert fires on the repo.

## Prerequisites

- CF CLI logged in against the target CF space (see `cf target`).
- Access to the BTP credstore admin UI at `https://<subaccount>.credential-store.cfapps.<region>.hana.ondemand.com/` — or the ability to run `cf credstore-write` via the credstore CLI plugin.
- The GitHub Actions secret `CONTENT_API_KEY` visible/editable at <https://github.com/sap-tutorials/tutorials-ims/settings/secrets/actions>.

The DEV env has three consumers of the key that must all move together:

1. **CAP srv** — reads via `srv/lib/secret-resolver.js` (credstore-first, env fallback).
2. **AppRouter** — reads via `approuter/lib/credstore-secret.js` for `/admin/rebuild` (uses `REBUILD_API_KEY`, not this key — separate rotation).
3. **CI publish workflows** — `.github/workflows/rebuild-content.yml` reads from the `CONTENT_API_KEY` repo secret.

## Steps

### 1. Generate a fresh value

```bash
# 40-byte URL-safe random string. Do NOT reuse a value that has ever been
# committed to git or shown in a doc.
openssl rand -base64 40 | tr -d '\n=/' | head -c 48
```

Copy the output to a scratchpad — you'll need it in three places.

### 2. Update the credstore

Preferred: BTP credstore admin UI → *Values* tab of the `tutorials-credstore` instance → find `CONTENT_API_KEY` → *Edit* → paste the new value → *Save*.

CLI alternative (requires the `cf credstore` plugin):

```bash
cf credstore-write CONTENT_API_KEY '<new-value>' --namespace tutorials-srv
```

### 3. Update the GitHub Actions secret

<https://github.com/sap-tutorials/tutorials-ims/settings/secrets/actions> → `CONTENT_API_KEY` → *Update secret* → paste the new value → *Update*.

### 4. Restart the srv to pick up the new value

The credstore cache in `srv/lib/secret-resolver.js` has a 5-minute TTL, so a restart is not strictly required — but it's the safest way to ensure the next publish uses the new value without a partial-cache window.

```bash
cf restart tutorials-srv
```

If PROD or QA is being rotated, do the same for `tutorials-srv-prod` / `tutorials-srv-qa`.

### 5. Verify

```bash
# The publish workflow accepts empty diffs as a no-op; use --dry-run to
# confirm auth succeeds without actually replacing content.
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims \
  --ref main -f mode=slug-targeted -f slug=tutorial-platform-feature-cookbook
```

Watch the workflow log for `HTTP 200` on the `/content/hashes` fetch — that's the auth check. If it 401s, the credstore write and the workflow secret don't agree yet.

### 6. Revoke the old value

Nothing to do — bearer tokens are single-value in the credstore. Overwriting is revocation.

## Post-rotation checklist

- [ ] Old value scrubbed from any incident tickets, chat threads, or shared docs.
- [ ] Rotation date recorded in the operations log (`docs/developers/operations/rotation-log.md` — start it if it doesn't exist).
- [ ] Next rotation scheduled 90 days out.

## Why the docs no longer contain the value

Prior to #887 the DEV value was a well-known ASCII string embedded in `CLAUDE.md`, the `deploy/dev.mtaext`, several developer docs, every superpowers plan that mentioned publish testing, and — worst — the built VitePress site under `docs/.vitepress/dist/` which is deployed to GitHub Pages at <https://sap-tutorials.github.io/tutorials-ims/>.

The fix:

- `deploy/dev.mtaext` now uses `${CONTENT_API_KEY}` placeholder (like `prod.mtaext` / `qa.mtaext`), resolved by `envsubst` in the deploy workflow.
- All doc references have been replaced with `$CONTENT_API_KEY` (shell variable) or `<DEV-content-api-key — fetch from BTP credstore>` placeholders.
- `docs/.vitepress/dist/` is regenerated at every `npm run docs:build`, so the scrub takes effect on the next docs deploy.
- The srv-lib admin-docs index (`srv/data/admin-docs-index.json`) is generated at build time by `scripts/build-admin-docs-index.ts`, so it picks up the scrubbed source automatically.

If any future documentation change ever needs to reference the value, use `$CONTENT_API_KEY` as an unresolved shell variable and point at this runbook.
