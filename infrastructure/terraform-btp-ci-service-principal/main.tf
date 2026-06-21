# =============================================================================
# terraform-btp-ci-service-principal
# -----------------------------------------------------------------------------
# Reproducible setup for a CI service principal (machine identity) authorized
# to deploy MTAs into Cloud Foundry spaces within a BTP subaccount. Replaces
# CF_USERNAME / CF_PASSWORD GitHub Actions secrets with a rotatable, role-
# scoped OAuth2 client_credentials grant.
#
# Architecture:
#   GitHub Actions ──$clientid + $clientsecret──> XSUAA ──token──> CF API
#
# Why this over a human service account:
#   - Not tied to a human user (no MFA, no vacation, no people leaving)
#   - Audit logs clearly distinguish CI traffic from human traffic
#   - Scoped per environment (dev/qa/prod) — leak in dev cannot deploy prod
#   - Rotatable cheaply (re-run `terraform apply -replace=...service_binding...`)
#
# The credentials are stored in Terraform state (treat the state file as a
# secret) and exposed as sensitive outputs. Pipe them into GitHub Actions
# environment-scoped secrets immediately after apply.
# =============================================================================

# -----------------------------------------------------------------------------
# 0. Look up the xsuaa "apiaccess" service plan ID for this subaccount.
#    Service plan IDs differ across regions, so resolve by name rather than
#    hardcoding a GUID. The xsuaa-apiaccess plan is the one that issues tokens
#    accepted by the CF API for the org/spaces in this subaccount.
# -----------------------------------------------------------------------------

data "btp_subaccount_service_plan" "xsuaa_apiaccess" {
  subaccount_id = var.subaccount_id
  offering_name = "xsuaa"
  name          = "apiaccess"
}

# -----------------------------------------------------------------------------
# 1. Create one role collection per CI environment.
#    Each environment gets a dedicated role collection so a leak in dev never
#    grants prod-deploy rights. The role collection bundles the *roles* that
#    define what the CI identity may do; the service-binding (step 3) attaches
#    those roles to the OAuth client via a `xs-security.json`-shaped param.
# -----------------------------------------------------------------------------

resource "btp_subaccount_role_collection" "ci_deployer" {
  for_each = var.environments

  subaccount_id = var.subaccount_id
  name          = "${var.name_prefix}-ci-deployer-${each.key}"
  description   = "${var.role_collection_description} | Environment: ${each.key} | CF org: ${var.cf_org_name} | CF space: ${each.value.cf_space}"

  # MTA Administrator + any caller-supplied extras (e.g. Destination Admin,
  # Connectivity Admin). CF Space Developer is granted to the service principal
  # directly via `cf set-space-role` in step 4 of the README — NOT via this
  # role collection (CF space roles aren't subaccount-level).
  roles = each.value.extra_role_assignments
}

# -----------------------------------------------------------------------------
# 2. Create one xsuaa-apiaccess service instance per environment.
#    Each instance is an XSUAA "OAuth client app" capable of issuing tokens
#    via the client_credentials grant. The `parameters` body declares which
#    grant types the client is allowed to use and which authorities it gets.
#
#    Reference for the parameters shape:
#      https://help.sap.com/docs/btp/sap-business-technology-platform/application-security-descriptor-configuration-syntax
# -----------------------------------------------------------------------------

resource "btp_subaccount_service_instance" "ci_sp" {
  for_each = var.environments

  subaccount_id  = var.subaccount_id
  serviceplan_id = data.btp_subaccount_service_plan.xsuaa_apiaccess.id
  name           = "${var.name_prefix}-ci-sp-${each.key}"

  parameters = jsonencode({
    # The unique xsappname for this principal; surfaces in audit logs as the
    # OAuth client identity. MUST be globally unique within the subaccount.
    xsappname = "${var.name_prefix}-ci-sp-${each.key}"

    # `tenant-mode: dedicated` keeps this single-tenant — appropriate for a
    # subaccount-scoped CI principal (no multi-tenant SaaS sharing).
    tenant-mode = "dedicated"

    # ONLY allow machine grants. Disallow password/authorization_code flows so
    # this client cannot impersonate a human even if its secret leaks.
    oauth2-configuration = {
      grant-types               = ["client_credentials"]
      credential-types          = ["binding-secret"]
      redirect-uris             = []
      token-validity            = 3600  # 1 hour. Reduce blast radius of token theft.
      refresh-token-validity    = 0     # No refresh tokens for machine clients.
      system-attributes         = []    # No system identity propagation.
      allowedproviders          = []    # Empty = only XSUAA (no SAML/OIDC providers).
    }

    # Empty scopes list — we don't define any custom scopes. The CF deploy
    # rights come from the role collection bound below, not from local scopes.
    scopes = []

    # Empty role-templates list — we use existing CF/MTA role templates via
    # the role collection, not new templates owned by this app.
    role-templates = []
  })
}

# -----------------------------------------------------------------------------
# 3. Create a service binding per instance.
#    The binding generates the `clientid` + `clientsecret` + `url` that the
#    deploy.yml workflow uses to mint tokens. `credentials` is a sensitive
#    JSON blob — we expose its decoded fields as sensitive outputs.
# -----------------------------------------------------------------------------

resource "btp_subaccount_service_binding" "ci_sp" {
  for_each = var.environments

  subaccount_id       = var.subaccount_id
  service_instance_id = btp_subaccount_service_instance.ci_sp[each.key].id
  name                = "${var.name_prefix}-ci-sp-${each.key}-binding"
}
