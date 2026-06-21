# =============================================================================
# terraform-btp-github-oidc
# -----------------------------------------------------------------------------
# Reproducible setup that lets a GitHub Actions workflow authenticate to an SAP
# BTP subaccount via OIDC federation (no password, no PAT, no long-lived token).
#
# Architecture:
#   GitHub Actions ──OIDC ID token──> IAS tenant ──SAML assertion──> BTP/XSUAA
#                                       (manual one-time config)
#
# This module manages the BTP side end-to-end (trust to IAS, role collections,
# OIDC claim-to-role mappings). The IAS-side step (registering GitHub Actions
# as a corporate IdP inside IAS) is one-time clickwork — see README.md.
# =============================================================================

# -----------------------------------------------------------------------------
# 1. Trust the IAS tenant from this BTP subaccount.
#    Creates an "origin" key (e.g. "tutorials-github-oidc") that subsequent
#    role-collection assignments reference. We set available_for_user_logon to
#    false so this trust never appears on the human login screen — only OIDC
#    federation traffic uses it.
# -----------------------------------------------------------------------------

resource "btp_subaccount_trust_configuration" "ias" {
  subaccount_id     = var.subaccount_id
  identity_provider = var.ias_tenant_host

  name        = "${var.trust_name_prefix}-github-oidc"
  description = "Trust to IAS for GitHub Actions OIDC federation (managed by Terraform)."
  origin      = "${var.trust_name_prefix}-github-oidc"

  # CRITICAL: hide this from the regular user-login screen. Only OIDC machine
  # traffic should use this trust; humans should keep using the default IDP.
  available_for_user_logon = false

  # auto_create_shadow_users would let any IAS-known user log in with a fresh
  # shadow user account. For a machine-only trust this is unnecessary noise.
  auto_create_shadow_users = false
}

# -----------------------------------------------------------------------------
# 2. Create one role collection per CI environment.
#    Each environment gets a dedicated role collection so a leak in dev never
#    grants prod-deploy rights. The role collection holds the *roles* that
#    define what the CI identity may do (CF Space Developer, MTA Admin, etc).
# -----------------------------------------------------------------------------

resource "btp_subaccount_role_collection" "ci_deployer" {
  for_each = var.environments

  subaccount_id = var.subaccount_id
  name          = "${var.trust_name_prefix}-ci-deployer-${each.key}"
  description   = "${var.role_collection_description} | Environment: ${each.key} | CF space: ${each.value.cf_space} | GitHub: ${var.github_repo}"

  # The primary role for this environment. Spread the optional extras after it.
  roles = concat(
    [
      {
        name                 = each.value.role_name
        role_template_app_id = each.value.role_template_app_id
        role_template_name   = each.value.role_template_name
      }
    ],
    each.value.extra_role_assignments
  )
}

# -----------------------------------------------------------------------------
# 3. Map the GitHub Actions OIDC 'sub' claim to each role collection.
#    The 'sub' claim filter restricts which workflow runs can assume the
#    collection. We gate on GitHub Environment to give you GH-side approval
#    gates "for free" on prod deploys.
#
#    GitHub OIDC 'sub' claim format when the workflow uses environment X:
#      repo:<owner>/<repo>:environment:<X>
#
#    Reference:
#      https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
# -----------------------------------------------------------------------------

resource "btp_subaccount_role_collection_assignment" "github_environment_to_rc" {
  for_each = var.environments

  subaccount_id        = var.subaccount_id
  role_collection_name = btp_subaccount_role_collection.ci_deployer[each.key].name

  # Bind to the IAS origin we created above. Without `origin =`, BTP looks up
  # the assignment under the default IDP and fails.
  origin = btp_subaccount_trust_configuration.ias.origin

  # The 'sub' claim is GitHub's per-workflow-run subject. The IAS pass-through
  # forwards it as the federated attribute named "sub".
  attribute_name  = "sub"
  attribute_value = "repo:${var.github_repo}:environment:${each.key}"
}
