# QA Channel Bootstrap

One-time setup procedure for the QA author-preview channel (`tutorials-srv-qa` + `tutorials-hana-qa` + `/tutorials-qa/*` route).

For day-to-day QA commands (`fetch-tutorials:qa`, `build:qa`, `publish-content:qa`, `qa:full`) see the Commands section in [CLAUDE.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/CLAUDE.md). For QA-specific gotchas (cache marker, `hugo.qa.toml`, `CONTENT_API_KEY_QA`) see the Gotchas section there.

---

## Step 1: Set CI secrets in tutorials-ims

In tutorials-ims repo: `CONTENT_API_KEY_QA`, `CAP_SRV_URL_QA`, `TUTORIAL_FETCH_TOKEN`, `SMOKE_QA_TOKEN`.

```bash
gh secret set CONTENT_API_KEY_QA      -R sap-tutorials/tutorials-ims -b "<value>"
gh secret set CAP_SRV_URL_QA          -R sap-tutorials/tutorials-ims -b "https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com"
gh secret set TUTORIAL_FETCH_TOKEN    -R sap-tutorials/tutorials-ims -b "<value>"
gh secret set SMOKE_QA_TOKEN          -R sap-tutorials/tutorials-ims -b "<value>"
```

Also set the QA URL repo-level **variables** (not secrets) so the post-deploy smoke step can resolve QA endpoints. `qa-routes.test.ts` self-skips when these are absent — without them, security regressions on `tutorials-srv-qa` won't be caught in CI.

```bash
gh variable set APPROUTER_URL_QA -R sap-tutorials/tutorials-ims -b "https://<approuter-host>"
gh variable set SRV_URL_QA       -R sap-tutorials/tutorials-ims -b "https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com"
```

## Step 2: Generate the dispatch token (`TUTORIALS_POC_DISPATCH_TOKEN`)

Create a fine-grained PAT (or GitHub App installation token) on a maintainer account with the minimum scope:

- Repository access: `sap-tutorials/tutorials-ims` only.
- Permissions: `Contents: read`, `Metadata: read`, `Actions: write` (for `repository_dispatch`).

Save the token value securely; it must be set as a per-repo secret in EACH `*-Contribution` repo (Step 3).

## Step 3: Distribute the dispatch token to every `-Contribution` repo

```bash
REPOS=$(npx tsx -e "
  import('./scripts/install-qa-workflows.ts').then(async m => {
    const repos = await m.listContributionRepos(/* real fetcher */);
    console.log(repos.join('\n'));
  });
")

for r in $REPOS; do
  echo "Setting TUTORIALS_POC_DISPATCH_TOKEN in sap-tutorials/$r..."
  gh secret set TUTORIALS_POC_DISPATCH_TOKEN \
    -R "sap-tutorials/$r" \
    -b "<dispatch-token-value>"
done
```

Verify each repo:

```bash
for r in $REPOS; do
  gh secret list -R "sap-tutorials/$r" | grep TUTORIALS_POC_DISPATCH_TOKEN || echo "MISSING: $r"
done
```

Any `MISSING:` line is a bootstrap gap that must be resolved before the matching `notify-qa.yml` PR (from Task 22) is merged — without the secret, the dispatch step in that workflow will fail with a 401.

## Step 4: Local deploy

**Before `cd .deploy && mbt build`, you must build BOTH prod and QA Hugo:**

```bash
npm run build:all                                      # prod hugo → hugo/public/
npm run fetch-tutorials:qa && npm run build:qa         # QA hugo → hugo/public-qa/
```

Without the QA build, `static/qa/` will be empty after `mbt build` and `/tutorials-qa/*` routes will 404. The `.deploy/mta.yaml` approuter `commands` block copies `hugo/public-qa/.` into `static/qa/` (and strips the static `tutorials/` subfolder so the dynamic HANA-served content route wins).

```bash
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext
```

Both `tutorials-srv` and `tutorials-srv-qa` apps should be healthy; HDI containers `tutorials-hana` and `tutorials-hana-qa` deployed.

## Step 5: Run `install-qa-workflows.ts` (opens PRs)

```bash
npm run install-qa-workflows
```

One PR per `-Contribution` repo. Merge each one once Step 3 has confirmed the token is in place for that repo.

## Step 6: Manually trigger first QA rebuild

```bash
gh workflow run rebuild-content-qa.yml -f slug=
```

## Step 7: Sanity check

```bash
curl -H "Cookie: ${SESSION_COOKIE_QA}" https://${APPROUTER_URL}/tutorials-qa/<known-slug> | grep "QA preview"
```

Expect: yellow banner present in HTML.

## Step 8: Assign role collection to first authors

Out-of-band via BTP cockpit: assign the **"Tutorials Author"** role collection (declared in `xs-security.json`, granting scope `$XSAPPNAME.Tutorial.Author`) to author user emails. Users must log out and back in for the new scope to appear in their JWT — until then, `/tutorials-qa/*` returns 403 even for assigned users.

## Lint-Token Setup (PR 5 author observability)

The `branch-staleness` lint rule reads from AuthorService with the `Tutorial.Author` scope. The XSUAA service-broker client gets `Tutorial.Author` automatically via `xs-security.json`'s `oauth2-configuration.authorities` block, so the token mint is a single CF + curl pair:

1. **Read the deployed XSUAA service-broker key:**

   ```bash
   cf service-key tutorials-xsuaa tutorials-xsuaa-key
   ```
   Reuse the existing key, or create a fresh one with `cf create-service-key tutorials-xsuaa <key-name>`. Read the `clientid`, `clientsecret`, and `url` fields from the output.
2. **Exchange for a bearer token** via the XSUAA `/oauth/token` endpoint with `grant_type=client_credentials`:

   ```bash
   curl -s -X POST "$XSUAA_URL/oauth/token" \
     -u "$CLIENTID:$CLIENTSECRET" \
     -d 'grant_type=client_credentials' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     | jq -r '.access_token'
   ```
   The token's `scope` array must include `<xsappname>.Tutorial.Author` — verify by base64-decoding the JWT payload (the `.` separator's middle segment).
3. **Store as the GitHub Actions secret** `TUTORIAL_AUTHOR_TOKEN`:

   ```bash
   gh secret set TUTORIAL_AUTHOR_TOKEN --repo sap-tutorials/tutorials-ims --body "$TOKEN"
   ```

No separate CI service-user / role-collection grant is required — the SB client gets `Tutorial.Author` directly from the XSUAA `authorities` declaration. (The "Tutorials Author" role collection is still needed for human authors who preview QA tutorials at `/tutorials-qa/*`; that flow is unchanged.)

**Token rotation note (v1):** XSUAA client-credentials tokens typically expire after ~12 hours. The v1 release path is `workflow_dispatch` only — when the operator manually kicks off the workflow, they refresh the token first. Cron-triggered runs may find the token expired; in that case the staleness rule silently skips, which is fine because findings are non-blocking notices. A v2 follow-up could add a token-refresh step to the workflow.

The rule skips silently when the token is missing or expired, so this is a soft-deploy step — the lint stays green throughout rollout.
