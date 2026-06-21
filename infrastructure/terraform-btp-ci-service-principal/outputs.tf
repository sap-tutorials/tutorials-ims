# =============================================================================
# Outputs
# -----------------------------------------------------------------------------
# Credentials are SENSITIVE. View them on the CLI with:
#   terraform output -json credentials | jq '.dev'
# Then immediately set them as GH Actions environment-scoped secrets and
# DELETE the local terminal scrollback (or use `terraform output -raw` piped
# directly to `gh secret set` — see README §4).
# =============================================================================

output "role_collection_names" {
  value       = { for k, rc in btp_subaccount_role_collection.ci_deployer : k => rc.name }
  description = "Map of environment name → BTP role collection name. Audit trail; cross-reference when reviewing 'who has what access'."
}

output "service_instance_names" {
  value       = { for k, si in btp_subaccount_service_instance.ci_sp : k => si.name }
  description = "Map of environment → xsuaa-apiaccess service instance name. Visit BTP cockpit → Subaccount → Instances and Subscriptions to find."
}

output "service_binding_ids" {
  value       = { for k, sb in btp_subaccount_service_binding.ci_sp : k => sb.id }
  description = "Map of environment → service binding GUID. Use with `terraform apply -replace=...service_binding...` to rotate secrets."
}

# -----------------------------------------------------------------------------
# THE BIG ONE — credentials per environment.
# Schema (per env): { clientid, clientsecret, tokenurl, url }
# - clientid:     OAuth2 client ID; not sensitive on its own, but pair with secret = full creds
# - clientsecret: OAuth2 client secret; ROTATE BY REPLACING THE SERVICE BINDING
# - tokenurl:     UAA token endpoint (e.g. https://<sub>.authentication.<region>.hana.ondemand.com/oauth/token)
# - url:          XSUAA base URL (same host, no /oauth/token suffix)
# -----------------------------------------------------------------------------

output "credentials" {
  sensitive   = true
  value       = { for k, sb in btp_subaccount_service_binding.ci_sp : k => jsondecode(sb.credentials) }
  description = "Sensitive. Map of environment → { clientid, clientsecret, tokenurl, url }. Set as GH Actions environment secrets immediately."
}

# Convenience helpers per env so you can `terraform output -raw clientid_dev` straight into `gh secret set`.
output "clientids" {
  value       = { for k, sb in btp_subaccount_service_binding.ci_sp : k => jsondecode(sb.credentials).clientid }
  description = "Map of environment → clientid. Not as sensitive as the secret, but treat as PII for the OAuth client."
}

output "tokenurls" {
  value       = { for k, sb in btp_subaccount_service_binding.ci_sp : k => jsondecode(sb.credentials).url }
  description = "Map of environment → XSUAA base URL. Not sensitive. Used as the OAuth2 token endpoint host in deploy.yml."
}

# -----------------------------------------------------------------------------
# Manual-step reminders. The post-apply checklist is in README §4; these are
# the per-env phrasings so you can pipe them through `terraform output -json
# post_apply_steps | jq -r '.dev'` directly into a CI runbook.
# -----------------------------------------------------------------------------

output "post_apply_steps" {
  value = {
    for k, v in var.environments : k => join("\n", [
      "1. Assign role collection '${btp_subaccount_role_collection.ci_deployer[k].name}' to the service principal:",
      "   btp assign security/role-collection '${btp_subaccount_role_collection.ci_deployer[k].name}' --to-service-instance '${btp_subaccount_service_instance.ci_sp[k].id}' --subaccount '${var.subaccount_id}'",
      "",
      "2. Grant CF Space Developer to the OAuth client in space '${v.cf_space}':",
      "   cf target -o '${var.cf_org_name}' -s '${v.cf_space}'",
      "   cf set-space-role 'sb-${btp_subaccount_service_instance.ci_sp[k].name}!*' '${var.cf_org_name}' '${v.cf_space}' SpaceDeveloper --client",
      "",
      "3. Push secrets into GitHub Actions environment '${k}':",
      "   gh secret set BTP_CF_CLIENT_ID --env ${k} --body \"$(terraform output -raw credentials | jq -r '.${k}.clientid')\"",
      "   gh secret set BTP_CF_CLIENT_SECRET --env ${k} --body \"$(terraform output -raw credentials | jq -r '.${k}.clientsecret')\"",
      "   gh secret set BTP_TOKEN_URL --env ${k} --body \"$(terraform output -raw credentials | jq -r '.${k}.url')\"",
    ])
  }
  description = "Per-environment manual post-apply steps. Run `terraform output -json post_apply_steps | jq -r '.dev'` to print the dev runbook."
}
