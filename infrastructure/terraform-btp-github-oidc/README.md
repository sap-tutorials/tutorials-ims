# terraform-btp-github-oidc

Reusable Terraform module that gives a GitHub Actions workflow OIDC-federated, password-free access to deploy into an SAP BTP subaccount.

**Status:** Module is reproducible across repos. Battle-tested in tutorials-ims; intended to be lifted into other repos by copying this directory (or by reaching it via `module "..." { source = "git::https://..." }` once stable).

## Why this exists

Long-lived BTP technical-user passwords in GitHub Actions secrets are operationally expensive (rotation, audit, exfiltration risk) and politically painful in regulated SAP organizations. OIDC federation replaces them with short-lived tokens minted per workflow run, scoped to a specific repo + environment, and impossible to extract from secret storage because they aren't stored.

The price: an SAP Identity Authentication (IAS) tenant has to sit in the middle. BTP/XSUAA does not (yet) trust generic OIDC issuers directly — it trusts IAS. So the chain is:

```
GitHub Actions  ──OIDC ID token──>  IAS  ──SAML assertion──>  BTP/XSUAA
   (per run)         (verified)   (federates)   (issues short-lived token)
```

This module manages the **BTP side end-to-end** (trust to IAS, role collections, OIDC claim → role mappings). The **IAS side is one-time clickwork**, documented below.

## Layout

| File | Purpose |
|---|---|
| `versions.tf` | Provider pinning |
| `variables.tf` | Inputs (subaccount, IAS tenant, GitHub repo, environments) |
| `main.tf` | Trust + role collections + claim mappings |
| `outputs.tf` | Origin key, RC names, deploy.yml hints |
| `terraform.tfvars.example` | Copyable starter values |
| `.gitignore` | Keeps `.tfstate` and `terraform.tfvars` out of git |

## Prerequisites

- BTP global account admin OR subaccount admin on the target subaccount
- IAS admin on the tenant you want to federate through
- GitHub repo admin (Settings → Environments)
- `terraform` ≥ 1.6
- `btp` CLI authenticated as a subaccount admin (`btp login`)
- `BTP_USERNAME` / `BTP_PASSWORD` env vars set for the Terraform provider (or `BTP_TF_*` per the provider's auth docs)

## Step 1 — IAS-side: register GitHub Actions as a corporate IdP (one-time, click-through)

This is what Terraform cannot manage (cleanly) today. Once it's done, every repo you connect via this module reuses the same IAS configuration.

1. Open the IAS admin console: `https://<your-tenant>.accounts.ondemand.com/admin`
2. **Applications & Resources → Corporate Identity Providers → Create**
3. Choose **OpenID Connect** as the protocol.
4. **Discovery URL**: `https://token.actions.githubusercontent.com/.well-known/openid-configuration`
5. **Client ID**: this can be any string — IAS uses it to disambiguate inbound tokens. Suggestion: `github-actions`.
6. **Trust** tab:
    - **Subject Name Identifier**: select **sub** (we want GitHub's per-workflow `sub` claim forwarded to BTP unchanged).
    - **Default Name ID Format**: Unspecified.
7. **Identity Federation** tab: enable **Use Identity Authentication user store** = OFF (we don't want IAS to look up a local user — just pass the claim through).
8. **Save**.
9. **Conditional Authentication** (sidebar) → add a rule pointing inbound traffic at this new IdP for the application you'll register in step 2.

When this is done, IAS knows how to verify a token from GitHub Actions and federate it onward.

## Step 2 — IAS-side: register the BTP subaccount as an Application

1. **Applications & Resources → Applications → Create**
2. Name: `BTP-<subaccount-name>-cf` (whatever you'll recognize).
3. Type: **SAP BTP solution** (SAML).
4. Once created, open the application:
    - **Subject Name Identifier** = `sub` (forwards GH's `sub` claim).
    - **Conditional Authentication** → route inbound login to the GitHub Actions IdP from step 1.
5. Note the **Application URL** — you'll see something like `https://<tenant>.accounts.ondemand.com/saml2/idp/metadata/<...>`. BTP needs this when you trust IAS in step 3 (but the Terraform module references the tenant host, not the per-app URL — so usually you don't need to copy it).

## Step 3 — BTP-side: run this Terraform module

```bash
cd infrastructure/terraform-btp-github-oidc
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars   # fill in subaccount_id, ias_tenant_host, github_repo, environments

terraform init
terraform plan -out tfplan
# review carefully — first run creates a trust config and N role collections
terraform apply tfplan
```

Outputs you'll need:
- `role_collection_names` — record these; used in any audit log conversation later
- `github_oidc_sub_claims` — cross-check against actual minted tokens if federation fails
- `deploy_workflow_environment_hints` — exact `environment: <name>` strings for deploy.yml

## Step 4 — GitHub-side: create environments + adapt deploy.yml

For **each** environment listed in your `environments` map:

1. GitHub repo → **Settings → Environments → New environment**
2. Name: match the Terraform map key exactly (`dev`, `qa`, `prod`).
3. (Recommended for `prod` only) Add required reviewers — GitHub will block the deploy job until a human approves.

Then in `.github/workflows/deploy.yml`, for the job that deploys to that environment:

```yaml
jobs:
  deploy-dev:
    runs-on: ubuntu-latest
    environment: dev                  # ← matches Terraform map key
    permissions:
      id-token: write                 # ← required for OIDC token minting
      contents: read

    steps:
      - name: Mint GitHub OIDC token (audience = IAS tenant)
        id: oidc
        uses: actions/github-script@v7
        with:
          script: |
            const aud = 'https://${{ vars.IAS_TENANT_HOST }}'
            const token = await core.getIDToken(aud)
            core.setSecret(token)
            core.setOutput('token', token)

      - name: Exchange OIDC token for BTP token via IAS
        run: |
          # Hits IAS's token endpoint with the GH OIDC assertion; receives a
          # BTP-acceptable token in return. Adjust the path if your IAS
          # tenant uses a different OAuth flow.
          BTP_TOKEN=$(curl -sfS -X POST \
            "https://${{ vars.IAS_TENANT_HOST }}/oauth2/token" \
            -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
            -d "subject_token=${{ steps.oidc.outputs.token }}" \
            -d "subject_token_type=urn:ietf:params:oauth:token-type:id_token" \
            -d "client_id=${{ vars.IAS_CLIENT_ID }}" \
            -d "scope=uaa.user" \
            | jq -r .access_token)
          echo "::add-mask::$BTP_TOKEN"
          echo "BTP_TOKEN=$BTP_TOKEN" >> "$GITHUB_ENV"

      - name: Authenticate cf CLI
        run: |
          cf api ${{ vars.CF_API_ENDPOINT }}
          cf auth --client-credentials cf "$BTP_TOKEN"   # exact flag depends on cf-cli version
          cf target -o ${{ vars.CF_ORG }} -s ${{ vars.CF_SPACE_DEV }}

      - name: Deploy
        run: cf deploy mta_archives/*.mtar -f
```

Repo-level **Variables** (`Settings → Secrets and variables → Actions → Variables`) — NOT secrets, because they aren't sensitive:
- `IAS_TENANT_HOST` = your IAS FQDN, same as Terraform's `ias_tenant_host`
- `IAS_CLIENT_ID` = the client ID you chose in Step 1.5
- `CF_API_ENDPOINT` = e.g. `https://api.cf.eu10-005.hana.ondemand.com`
- `CF_ORG` = your CF org name
- `CF_SPACE_DEV` / `CF_SPACE_QA` / `CF_SPACE_PROD` = per-env space names

Remove the old `CF_USERNAME` / `CF_PASSWORD` secrets only after the OIDC flow has run green at least once.

## Verifying it works

```bash
# 1. On the BTP side — confirm Terraform applied cleanly
terraform output

# 2. After running the workflow once with `permissions: id-token: write`,
#    inspect the actual sub claim GitHub minted. Add this debug step to deploy.yml:
- run: |
    echo "Token claims:"
    echo '${{ steps.oidc.outputs.token }}' | cut -d. -f2 | base64 -d | jq .

# 3. The 'sub' field should look like 'repo:<owner>/<repo>:environment:<env>'.
#    Compare against `terraform output github_oidc_sub_claims`.
```

## Common failure modes

| Symptom | Most likely cause |
|---|---|
| `401 Unauthorized` at the IAS token-exchange step | IAS-side IdP registration's `Client ID` / `Discovery URL` don't match what GitHub minted; verify the audience claim on the GH token (`aud` should be your IAS tenant URL). |
| `403 Forbidden` from `cf deploy` after authenticating | The role collection lacks `MtaDeployAdministrator`. Re-check `extra_role_assignments` in tfvars. |
| `cf auth` succeeds but `cf target -s` fails | Role collection lacks `Space Developer` for that space — or the `cf_space` in tfvars doesn't match the actual space name. |
| `terraform apply` reports `invalid origin` | IAS tenant FQDN doesn't match an existing trust source. Run `btp list security/trust --subaccount <id>` to see what BTP actually knows about. |
| Workflow runs locally OK but GH run fails with "OIDC token claim 'sub' did not match" | GH minted `sub=repo:...:ref:refs/heads/main` instead of `:environment:dev` — that means the job didn't have `environment: dev` set. Add it. |

## Reusing in another repo

```bash
# In the consumer repo:
mkdir -p infrastructure
cp -r /path/to/tutorials-poc/infrastructure/terraform-btp-github-oidc infrastructure/

cd infrastructure/terraform-btp-github-oidc
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — same subaccount_id + ias_tenant_host as before, just a new github_repo
terraform init
terraform apply
```

If you find yourself doing this more than twice, promote this directory to its own repo (`sap-tutorials/terraform-btp-github-oidc` or similar) and consume it via:

```hcl
module "btp_oidc" {
  source = "git::https://github.com/sap-tutorials/terraform-btp-github-oidc.git?ref=v1.0.0"
  # ... vars
}
```

## State storage

The `.gitignore` keeps `*.tfstate` out of git. For a one-off setup that's fine — re-run is idempotent against the cloud. For long-running shared state, configure remote state (AWS S3, Terraform Cloud, or BTP Object Store) in a `backend.tf` file before the first `terraform apply`.

## What this module does NOT do

- It does not configure the IAS side (see Steps 1–2).
- It does not write to `deploy.yml`. The README shows the workflow changes; you apply them by hand.
- It does not create the GitHub Environments. GitHub doesn't expose those via the Terraform GH provider's `github_repository_environment` cleanly enough to be worth the dependency right now.
- It does not rotate credentials — there are no credentials to rotate. That's the whole point.
