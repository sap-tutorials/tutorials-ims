# terraform-btp-ci-service-principal

Reusable Terraform module that creates a **CI service principal** (XSUAA client_credentials OAuth client) authorized to deploy MTAs into an SAP BTP Cloud Foundry space. Replaces `CF_USERNAME` / `CF_PASSWORD` GitHub Actions secrets with rotatable, role-scoped, machine-only credentials.

**Status:** Reproducible across repos. Copy this directory, edit `terraform.tfvars`, `terraform apply`.

## Why this exists

The pre-existing pattern was a human user account whose password was pasted into GH Actions secrets as `CF_USERNAME` + `CF_PASSWORD`. Problems:

- Tied to a person (MFA breaks CI, vacation breaks CI, leaving the company breaks CI)
- Indistinguishable from human traffic in audit logs
- Same credential deploys dev AND prod (no environment-level scoping)
- Rotation is painful — change the password, push to GH secrets, hope nothing breaks

A CI service principal fixes all four:

- Not a person — it's an OAuth2 `client_credentials` grant
- Audit logs show `client_id=tutorials-ci-sp-dev` instead of a human's name
- One principal per environment; leak in dev cannot deploy prod
- Rotation = `terraform apply -replace='btp_subaccount_service_binding.ci_sp["dev"]'` — generates a fresh secret in seconds

It is NOT zero-secret (that's what the OIDC federation path would give you, at the cost of an IAS tenant). But it's the right balance of security and operational simplicity for a single subaccount setup.

## Architecture

```
GitHub Actions  ──$clientid + $clientsecret──>  XSUAA  ──short-lived token──>  CF API
   (per run)       (env-scoped GH secrets)   (issues)        (validates)
```

For each environment in your `environments` map, this module creates:

1. **One xsuaa-apiaccess service instance** — the XSUAA OAuth client app, configured with `grant_types: ["client_credentials"]` only, 1-hour token lifetime, no refresh tokens
2. **One service binding** — generates the `clientid` + `clientsecret` you'll set as GH Actions secrets
3. **One role collection** — bundles MTA Administrator (+ any extras you specify)

CF Space Developer is granted **separately** (one `cf set-space-role` command per env, in Step 4 below) because CF space roles live at the CF API layer, not the BTP subaccount layer.

## Layout

| File | Purpose |
|---|---|
| `versions.tf` | Provider pin (`SAP/btp ~> 1.11`, `terraform >= 1.6`) |
| `variables.tf` | Inputs: `subaccount_id`, `cf_org_name`, `environments` map |
| `main.tf` | Service instance + binding + role collection (heavily commented) |
| `outputs.tf` | Sensitive credentials + post-apply step printer |
| `terraform.tfvars.example` | Copyable starter values |
| `.gitignore` | Keeps `.tfstate` and `terraform.tfvars` out of git |

## Prerequisites

- BTP global account admin OR subaccount admin on the target subaccount
- CF org admin on the org you want to deploy into (needed for `cf set-space-role` in Step 4)
- GitHub repo admin (Settings → Environments)
- `terraform` ≥ 1.6
- `btp` CLI authenticated as a subaccount admin (`btp login`)
- `cf` CLI authenticated against your CF org (`cf login`)
- `BTP_USERNAME` / `BTP_PASSWORD` env vars set for the Terraform provider (or `BTP_TF_*` per the provider's auth docs)

## Step 1 — Configure inputs

```bash
cd infrastructure/terraform-btp-ci-service-principal
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Required fields:

- `subaccount_id` — find with `btp list accounts/subaccount --format json | jq '.value[] | {name, guid}'`
- `cf_org_name` — your CF org (e.g. `tutorial-system`)
- `environments` — at minimum a `dev` entry; add `qa` once dev is verified

Look up the MTA Administrator role's `role_template_app_id` once and reuse it across envs:

```bash
btp list security/roles --subaccount <your-id> --format json \
  | jq -r '.value[] | select(.name=="MtaDeployAdministrator")
          | "role_template_app_id = \"\(.role_template_app_id)\""'
# → role_template_app_id = "mta_!t10"   (the !t number varies per subaccount)
```

## Step 2 — Plan + apply the Terraform

```bash
terraform init
terraform plan -out tfplan
# Review carefully on first run — confirms the service plan ID lookup worked
# and that the role collection details are right.
terraform apply tfplan
```

What you'll see created for each environment:

- `btp_subaccount_role_collection.ci_deployer["dev"]`
- `btp_subaccount_service_instance.ci_sp["dev"]`
- `btp_subaccount_service_binding.ci_sp["dev"]`

## Step 3 — Bind the role collection to the service principal

The role collection exists. The service principal exists. But the principal can't USE the role collection until you connect them. The `btp` CLI does this in one command (run once per env):

```bash
# For each environment in your tfvars, find its service-instance GUID:
terraform output -raw service_instance_names

# Then assign the role collection to that service instance:
btp assign security/role-collection 'tutorials-ci-deployer-dev' \
  --to-service-instance <service-instance-guid> \
  --subaccount <your-subaccount-guid>
```

Or print the exact commands per environment:

```bash
terraform output -json post_apply_steps | jq -r '.dev'
```

## Step 4 — Grant CF Space Developer to the OAuth client

The CF API doesn't know about XSUAA role collections directly — it has its own space role model. You need ONE command per environment:

```bash
cf target -o <your-cf-org> -s dev
cf set-space-role 'sb-tutorials-ci-sp-dev!*' <your-cf-org> dev SpaceDeveloper --client
```

The `sb-<service-instance-name>!*` is the OAuth client identifier that CF understands. The `--client` flag tells `cf set-space-role` this is a service principal, not a user.

(The `post_apply_steps` Terraform output prints the exact command per env — copy-paste from there.)

## Step 5 — Push credentials to GitHub Actions secrets

First create GitHub Environments (one per env in your tfvars) — Settings → Environments → New.

For `prod` (when you add it later), set required reviewers in that environment's settings.

Then push the secrets per environment:

```bash
# Make sure gh CLI is authed against the repo:
gh repo set-default sap-tutorials/tutorials-ims

# Pipe Terraform output directly into gh secret — credentials never hit shell history
gh secret set BTP_CF_CLIENT_ID     --env dev --body "$(terraform output -json credentials | jq -r '.dev.clientid')"
gh secret set BTP_CF_CLIENT_SECRET --env dev --body "$(terraform output -json credentials | jq -r '.dev.clientsecret')"
gh secret set BTP_TOKEN_URL        --env dev --body "$(terraform output -json credentials | jq -r '.dev.url')"
```

Repeat for `qa` (and later `prod`).

**Note:** the secrets are environment-scoped — only jobs with `environment: dev` in deploy.yml can read the dev ones. This is the security feature: a stray test job without `environment:` can't see them.

## Step 6 — Update deploy.yml

For each job that deploys, add `environment:` + a CF auth step:

```yaml
jobs:
  deploy-dev:
    runs-on: ubuntu-latest
    environment: dev                   # ← matches Terraform map key + GH env name
    steps:
      - uses: actions/checkout@v4

      - name: Install cf CLI
        run: |
          curl -L "https://packages.cloudfoundry.org/stable?release=linux64-binary&source=github" | tar -xz
          sudo mv cf8 /usr/local/bin/cf

      - name: Authenticate to CF as service principal
        env:
          CF_API: ${{ vars.CF_API_ENDPOINT }}        # e.g. https://api.cf.eu10-005.hana.ondemand.com
          CF_ORG: ${{ vars.CF_ORG }}
          CF_SPACE: ${{ vars.CF_SPACE_DEV }}         # space name from your CF setup
          BTP_CF_CLIENT_ID: ${{ secrets.BTP_CF_CLIENT_ID }}
          BTP_CF_CLIENT_SECRET: ${{ secrets.BTP_CF_CLIENT_SECRET }}
        run: |
          cf api "$CF_API"
          cf auth "$BTP_CF_CLIENT_ID" "$BTP_CF_CLIENT_SECRET" --client-credentials
          cf target -o "$CF_ORG" -s "$CF_SPACE"

      - name: Deploy MTA
        run: cf deploy mta_archives/*.mtar -f
```

**Drop the old secrets ONLY after this works green:** delete `CF_USERNAME` and `CF_PASSWORD` from repo-level secrets once at least one deploy has succeeded with the new auth path.

## Rotating the secret

If `BTP_CF_CLIENT_SECRET` ever leaks (logged, screenshotted, exfiltrated):

```bash
# Replace the binding — gets a fresh clientsecret. The clientid stays the same.
terraform apply -replace='btp_subaccount_service_binding.ci_sp["dev"]'

# Re-push the secret to GH
gh secret set BTP_CF_CLIENT_SECRET --env dev --body "$(terraform output -json credentials | jq -r '.dev.clientsecret')"
```

That's the whole rotation. ~30 seconds, no human accounts involved, no MTA Administrator role-collection re-assignment needed (the role collection is bound to the service INSTANCE, which is unchanged).

## Common failure modes

| Symptom | Most likely cause |
|---|---|
| `terraform plan` errors with "no service plan found" | The `data "btp_subaccount_service_plan" "xsuaa_apiaccess"` lookup failed. Check the subaccount has the xsuaa entitlement: `btp list accounts/entitlement --subaccount <id>` — look for `xsuaa` offering with `apiaccess` plan. |
| `cf auth` returns `Server error, status code: 401` | The role collection isn't bound to the service instance yet (Step 3 missed) or the binding was rotated but secrets weren't re-pushed (Step 5). |
| `cf target -s` works but `cf deploy` returns `403 Forbidden` | MTA Administrator role missing from the role collection — check `extra_role_assignments` in your tfvars. |
| `cf target -s` returns `org 'xxx' not found` | CF Space Developer not granted (Step 4 missed). The principal can authenticate but can't see the org/space. |
| `cf auth ... --client-credentials` returns `Credentials were rejected` | clientid OR clientsecret has trailing whitespace from copy-paste. Re-run the `gh secret set` with `terraform output -json ... \| jq -r` (NOT `terraform output credentials` which adds quotes). |
| `Error: error decoding credentials JSON` from Terraform | The provider returned the binding before it was ready. Re-run `terraform apply` — the second run will see the fully-provisioned binding. |

## Reusing in another repo

```bash
# In the consumer repo:
mkdir -p infrastructure
cp -r /path/to/tutorials-ims/infrastructure/terraform-btp-ci-service-principal infrastructure/

cd infrastructure/terraform-btp-ci-service-principal
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars   # update subaccount_id, cf_org_name, name_prefix, environments
terraform init
terraform apply
```

The `name_prefix` ensures the consuming repo's resources don't collide with `tutorials-*` in BTP cockpit.

If you find yourself doing this more than twice, promote this directory to its own repo and consume it via:

```hcl
module "btp_ci_sp" {
  source = "git::https://github.com/sap-tutorials/terraform-btp-ci-service-principal.git?ref=v1.0.0"
  # ... vars
}
```

## State storage

The `.gitignore` keeps `*.tfstate` out of git. The state file contains the clientsecret in cleartext — protect it like any other credential. For shared state, configure a remote backend (S3 with KMS encryption, Terraform Cloud, BTP Object Store) in a `backend.tf` file before the first `terraform apply`.

## What this module does NOT do

- It does not provision the CF org or spaces — assumes they exist.
- It does not call `cf set-space-role` (the README has the one-line manual command).
- It does not push GitHub secrets — `gh secret set` is a separate dance.
- It does not configure GitHub Environments (gh repo settings — out of band).
- It does not eliminate secrets entirely — for that, see the alternative OIDC federation approach (archived earlier in this branch's history at commit `9f3cf87e`; requires an IAS tenant; deferred).

## Future upgrade path: zero-secret OIDC

If you ever want true zero-secret auth (no clientsecret in GH at all), the upgrade is:

1. Provision an IAS tenant in BTP
2. Register GitHub Actions as a corporate IdP in IAS
3. Restore the `terraform-btp-github-oidc` module from this branch's git history
4. Update deploy.yml to mint an OIDC token instead of using `client_credentials`

Worth doing if you accumulate >5 service principals across repos. Not worth doing for just this one repo.
