# =============================================================================
# Outputs — feed these into deploy.yml and the IAS-side configuration.
# =============================================================================

output "origin_key" {
  value       = btp_subaccount_trust_configuration.ias.origin
  description = "The 'origin' key BTP uses to identify the IAS trust. The deploy.yml workflow does NOT need this at runtime (it's stamped into the IAS-issued token); kept for documentation and troubleshooting."
}

output "trust_name" {
  value       = btp_subaccount_trust_configuration.ias.name
  description = "Display name of the trust configuration in BTP cockpit. Visit Subaccount → Security → Trust Configuration to find this entry."
}

output "role_collection_names" {
  value       = { for k, rc in btp_subaccount_role_collection.ci_deployer : k => rc.name }
  description = "Map of environment name → BTP role collection name. Use these names when documenting who has what access."
}

output "github_oidc_sub_claims" {
  value       = { for k, _ in var.environments : k => "repo:${var.github_repo}:environment:${k}" }
  description = "The OIDC 'sub' claim value GitHub Actions will mint for each environment. Cross-check against the actual JWT in a workflow run (decode via jwt.io) if federation fails."
}

output "deploy_workflow_environment_hints" {
  value = {
    for k, _ in var.environments : k => "Add `environment: ${k}` to the deploy.yml job that targets this space; GH will mint sub=repo:${var.github_repo}:environment:${k} which matches this Terraform-managed mapping."
  }
  description = "Copy-paste hints for what each deploy.yml job needs."
}
