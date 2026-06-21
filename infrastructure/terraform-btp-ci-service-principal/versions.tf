terraform {
  required_version = ">= 1.6.0"

  required_providers {
    btp = {
      source  = "SAP/btp"
      version = "~> 1.11" # Latest stable as of 2026-06; pin major.minor to avoid surprise breaking changes.
    }
  }
}
