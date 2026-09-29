# M1 POC Result — IAS Public PKCE Works; Identity Reconciliation Required

**Date:** 2026-09-29 · **Status:** POC complete, decision point · **Refs:** #16, #30, ias-migration-impact-research, ias-tenant-foundation

## What the POC proved (empirical, real token captured)

A full **authorization_code + PKCE, public client, NO client secret** flow against the IAS tenant `atxgsg7zi.accounts.ondemand.com` **succeeded end-to-end** (token endpoint HTTP 200). This is the capability XSUAA categorically could not provide (XSUAA `application` plan rejects public-client / `credential-types:none`; confidential-client secret-omit returns `invalid_client`). **IAS public PKCE is viable.**

Captured token (Thomas Jung, standalone IAS OIDC app, Subject Name Identifier switched off the empty `personnelNumber`):
```
sub:        ba411614-11a4-42a3-9867-0919861a7dac
user_uuid:  ba411614-11a4-42a3-9867-0919861a7dac   (identical to sub)
scim_id:    ba411614-11a4-42a3-9867-0919861a7dac   (identical)
email/mail: thomas.jung@sap.com
given_name / family_name / sap_id_type:user
```

## M1 verdict: RED — no P/S/I number in any IAS claim

- Our data model + NGDS badge gate key on `Users.sapId` = the **P/S/I personnel number** (`^[PSIps]\d{6,}$`), sourced today from XSUAA's `user_uuid`. ~798k rows.
- IAS emits only the **Global User ID UUID** (same value in `sub` / `user_uuid` / `scim_id`). The **`personnelNumber` attribute is EMPTY** for this user (that was the "Attribute personnelNumber is not supported" / IdP-config-incorrect error, KBA 2954081) — and is expected empty for the largely non-employee community/external user population.
- **A native IAS token cannot be mapped directly to the existing `Users.sapId`.** No claim carries the P-number.

## Implication: "project, not a flip" (confirmed)

IAS-for-MCP splits into two separable problems:
1. **Authentication** — SOLVED. Public PKCE works; DEV-isolated from PROD (app-scoped, no subaccount trust mutation — proven); reproducible via the `SAP/terraform-provider-sap-cloud-identity-services` `sci_application` resource.
2. **Identity reconciliation** — a real workstream. Mapping IAS-UUID → existing `Users.sapId` needs one of:
   - **UUID→P-number lookup** at login via the SAP ID Service `/cps/user/...` API (note: that API rate-limits hard — SCI #632).
   - **IPS-synced mapping** table (Global User ID ↔ SAP Universal ID / P-number).
   - **Store the IAS UUID as a new alt-key** on `Users` alongside `sapId`, backfill the ~798k rows, and add an IAS-aware branch to `resolveUserSapId`. This also forces the HANA UNIQUE hardening + NGDS-gate revisit flagged in the impact research.

## Options (decision is Tom's)

- **A. Pause IAS-for-MCP.** Auth is proven but identity reconciliation is a sizable, PROD-touching workstream (798k rows, NGDS gate, HANA uniqueness). Ship/keep **PAT** as the interim OAuth-adjacent path; schedule IAS identity reconciliation as its own planned project (possibly aligned with #2506).
- **B. Design the reconciliation** now — pick the mapping mechanism (lookup vs IPS vs alt-key backfill), spec it, then wire IAS-for-MCP in DEV.
- **C. Reconsider the requirement** — does interactive MCP OAuth truly need to resolve to the *existing* P-number-keyed identity, or can MCP users be keyed on the IAS UUID (new identity space) for the MCP surface only, avoiding the 798k reconciliation?

## Cleanup owed
- Delete POC IAS artifacts when done: `cf delete-service tutorials-identity-mcp` (broker app) + delete the console "Tutorials MCP POC (standalone)" app. (Left in place now pending the decision.)
- Local probe scripts under the job tmp dir are throwaway.
