variable "subaccount_id" {
  type        = string
  description = "GUID of the BTP subaccount that the GitHub Actions OIDC identity will be granted access to. Run `btp list accounts/subaccount` to find this."

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subaccount_id))
    error_message = "subaccount_id must be a lowercase UUID."
  }
}

variable "ias_tenant_host" {
  type        = string
  description = "FQDN of the SAP Identity Authentication (IAS) tenant that will sit between GitHub Actions and BTP. Example: 'mycompany.accounts.ondemand.com'. You configure GitHub Actions as a corporate IdP inside this IAS tenant once, then point this Terraform module at it."

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.ondemand\\.com$", var.ias_tenant_host))
    error_message = "ias_tenant_host must end in .ondemand.com (standard IAS tenant naming)."
  }
}

variable "github_repo" {
  type        = string
  description = "GitHub repository slug allowed to assume the BTP role collection. Example: 'sap-tutorials/tutorials-ims'. Used to construct the OIDC 'sub' claim filter."

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "github_repo must be in '<owner>/<repo>' form."
  }
}

variable "trust_name_prefix" {
  type        = string
  description = "Display name and origin-key prefix for the BTP trust configuration. Becomes 'origin_key = \"<prefix>-github-oidc\"'. Keep it short; visible in BTP cockpit and used as the 'origin' in claim mappings."
  default     = "tutorials"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.trust_name_prefix))
    error_message = "trust_name_prefix must be lowercase alphanumeric with dashes."
  }
}

variable "environments" {
  type = map(object({
    cf_space             = string # CF space name (e.g. "dev", "qa", "prod") used in role descriptions
    role_template_app_id = string # XSUAA app-id that owns the role template — find via `btp list security/roles` or cockpit
    role_template_name   = string # role template name from the same XSUAA app
    role_name            = string # the role's display name in BTP (often matches role_template_name)
    extra_role_assignments = optional(list(object({
      name                 = string
      role_template_app_id = string
      role_template_name   = string
    })), [])
  }))

  description = <<-EOT
    Per-environment role collection definitions. The map key (e.g. "dev", "qa", "prod") is the GitHub Actions environment name.
    Each environment produces:
      - one role collection named "<trust_name_prefix>-ci-deployer-<key>"
      - a claim mapping that grants it to OIDC subjects with sub = "repo:<github_repo>:environment:<key>"
      - at least one role assignment (Space Developer-equivalent for CI deploys)
    Use `extra_role_assignments` to layer in MTA Administrator, Destination Administrator, etc. without restructuring.
  EOT

  default = {}
}

variable "role_collection_description" {
  type        = string
  description = "Description shown in BTP cockpit for each generated role collection. Identifies these as machine-managed; warn humans not to hand-edit."
  default     = "Managed by Terraform (terraform-btp-github-oidc). Grants a GitHub Actions OIDC identity CI deploy rights. Do not edit by hand."
}
