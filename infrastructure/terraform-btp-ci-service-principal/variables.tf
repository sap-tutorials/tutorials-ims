variable "subaccount_id" {
  type        = string
  description = "GUID of the BTP subaccount that hosts the CI service principal. Run `btp list accounts/subaccount` to find this."

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subaccount_id))
    error_message = "subaccount_id must be a lowercase UUID."
  }
}

variable "btp_globalaccount" {
  type        = string
  description = "Global-account subdomain (NOT the GUID — though they happen to be the same string for GUID-named global accounts). Required by the SAP/btp provider; cannot be sourced from BTP_GLOBALACCOUNT env var. Find via `btp get accounts/global-account --format json | jq -r .subdomain`."

  validation {
    condition     = length(var.btp_globalaccount) > 0
    error_message = "btp_globalaccount cannot be empty."
  }
}

variable "cf_org_name" {
  type        = string
  description = "Cloud Foundry org name the principal should be allowed to target (e.g. 'tutorial-system'). Recorded in role-collection descriptions for audit clarity."
}

variable "name_prefix" {
  type        = string
  description = "Prefix for the generated service instance, binding, and role collection names. Becomes '<prefix>-ci-sp-<env>' and '<prefix>-ci-deployer-<env>'. Keep short; lowercase alphanumeric + dashes."
  default     = "tutorials"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric with dashes."
  }
}

variable "environments" {
  type = map(object({
    cf_space = string # CF space name this principal will deploy into (e.g. "dev", "qa", "prod")
    extra_role_assignments = optional(list(object({
      name                 = string
      role_template_app_id = string
      role_template_name   = string
    })), [])
  }))

  description = <<-EOT
    Per-environment service-principal definitions. The map key (e.g. "dev", "qa", "prod") suffixes every generated BTP resource so resources are easy to identify and audit.

    Each environment produces:
      - one xsuaa apiaccess service instance named "<name_prefix>-ci-sp-<key>"
      - one service binding that emits clientid + clientsecret credentials (returned as sensitive outputs)
      - one role collection named "<name_prefix>-ci-deployer-<key>"
      - role assignments to that collection (caller controls via extra_role_assignments)

    The credentials are returned as Terraform outputs (sensitive). Pipe them into GitHub Actions environment-scoped secrets immediately after `terraform apply`.

    PRODUCTION GUIDANCE: keep "prod" in a SEPARATE Terraform workspace/state from "dev" + "qa" so a `terraform destroy` against the dev workspace cannot disable prod CI.
  EOT

  default = {}
}

variable "role_collection_description" {
  type        = string
  description = "Description shown in BTP cockpit for each generated role collection. Identifies these as machine-managed; warn humans not to hand-edit."
  default     = "Managed by Terraform (terraform-btp-ci-service-principal). Grants a CI service principal CF deploy rights. Do not edit by hand."
}
