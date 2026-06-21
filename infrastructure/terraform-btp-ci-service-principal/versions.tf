terraform {
  required_version = ">= 1.6.0"

  required_providers {
    btp = {
      source  = "SAP/btp"
      version = "~> 1.11" # Latest stable as of 2026-06; pin major.minor to avoid surprise breaking changes.
    }
  }
}

# The provider's `globalaccount` argument cannot be sourced from the
# BTP_GLOBALACCOUNT environment variable (unlike username/password) — the
# provider docs require it in HCL. We read from a variable so callers can
# set it once in terraform.tfvars (or via TF_VAR_btp_globalaccount).
#
# Username and password ARE sourced from BTP_USERNAME / BTP_PASSWORD env vars,
# which the .env.local file provides at apply time.
provider "btp" {
  globalaccount = var.btp_globalaccount
}

