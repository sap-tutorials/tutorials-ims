# XSUAA Role Collection Assignment

Post-Phase-A1 ([#809](https://github.com/sap-tutorials/tutorials-ims/issues/809)) the `Tutorial.Author` scope is no longer auto-granted to every authenticated JWT. QA preview (`/tutorials-qa/*`, `/qa-search/*`) and the author service (`/author/*`) now require explicit assignment to the `Tutorials Author` role collection.

This runbook covers **assigning users** to role collections, **auditing current assignments**, and the **rollout sequence** when granting new access.

## Role collection catalog

Defined in [xs-security.json](../../../xs-security.json). Six collections:

| Role collection | Grants scope | Gates |
|---|---|---|
| `Tutorials Admin` | `Admin`, `DisplayApp`, `DeveloperApp`, `Everyone` | `/admin/*`, `/admin-ui/`, `/analytics-ui/`, `/admin/exports/*`, `/admin/analytics/*` |
| `Tutorials SuperAdmin` | `SuperAdmin` + everything Admin grants | KG concept publish/unpublish; anything gated on `SuperAdmin` in Phase C |
| `Tutorials Developer` | `DeveloperApp`, `Everyone` | authenticated `/api/*` progress endpoints |
| `Tutorials Display` | `DisplayApp`, `Everyone` | `/display/*` (event-monitor dashboards) |
| `Tutorials Author` | `Tutorial.Author`, `Everyone` | `/tutorials-qa/*`, `/qa-search/*`, `/author/*`, srv-qa `/content/*` |
| `Tutorials Scanner` | `MobileApp`, `Everyone` | `/scanner-ui/`, `/scanner-vue/`, `/scanner/*` |

## Assignment via BTP Cockpit

1. Log in to the BTP Cockpit for the target subaccount (currently `tutorial-system` in eu10-005).
2. Navigate to **Security → Role Collections**.
3. Click the target collection (e.g. `Tutorials Author`).
4. In the **Users** tab: **Edit**, add rows with `SAP IDP` origin and the user's e-mail as `ID`. Save.

User needs to log out and log back in for the JWT to pick up the new scope.

## Assignment via `btp` CLI

```bash
btp target --subaccount <subaccount-guid>
btp assign security/role-collection "Tutorials Author" \
  --to-user user@sap.com \
  --of-idp <origin-id>
```

Notes:
- `<origin-id>` is typically `sap.default` for SAP IDP. Run `btp list security/user-origin` to confirm.
- Batch assign by looping over a text file of e-mails; the command is idempotent.

## Auditing current assignments

**Cockpit path:** Security → Role Collections → click a collection → Users tab lists holders.

**CLI path (JSON):**

```bash
btp get security/role-collection "Tutorials Author" --format json | jq '.userAssignments[]'
```

Snapshot the output before Phase A1 ships so you know which users need re-granting after the auto-grant is removed.

## Rollout sequence for Phase A1

1. **Snapshot current QA-preview access** (users who need `Tutorials Author` explicitly). Because the auto-grant currently satisfies the gate, the current `Tutorials Author` role-collection membership is likely near-empty — real active QA authors need to be identified from GitHub activity or asked directly.

   Suggested query: check who has recently opened PRs against `*-Contribution` repos in the sap-tutorials GitHub org. Cross-reference with SAP IDP e-mails.

2. **Assemble the initial grant list.** In practice this is: the QA-content authoring team, the tutorials-ims maintainer team, anyone who has used `/tutorials-qa/*` recently. When in doubt, err on the side of granting — a false-positive grant is low-cost; a missed grant blocks legitimate work.

3. **Grant the collection to every user on the list** via cockpit or CLI *before* deploying the A1 change. Grants are cheap and can be added at any time, but adding them in advance means no user hits a 401 wall.

4. **Deploy Phase A1** (removes the auto-grant from `xs-security.json`).

5. **Run `cf update-service`** to reconcile the deployed XSUAA instance with the new config:

   ```bash
   cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
   ```

   (Substitute the correct service-instance name for QA / PROD.)

6. **Verify via `/auth/user`.** Pick a granted user and a non-granted user; log both in via the approuter and hit `/auth/user`. The `isAuthor` field must be `true` for the granted user and `false` for the non-granted user.

## Revocation

Removing a user from a role collection takes effect on their next JWT refresh (default: ~12 hours, or immediately if they log out and back in).

## Post-Phase-A3 note — tech-user role misconfig

Phase A3 also removed the silent-Admin default for role-less tech-user entries in `TenantSettings.techUsers`. Role-less entries are now **skipped with a warning** at the srv layer. The warning fires lazily on the first Basic-auth request against a given srv process (not at boot) — so operators verifying a deploy should send one Basic-auth request through the tech-user path (or wait for one to occur naturally) to surface any lingering misconfigured entries in the srv logs.

Pre-deploy audit: run the DEV/PROD `TenantSettings.techUsers` audit query in the Phase A plan (Check-4/-5) and back-fill any role-less entries via the admin UI (`/admin-ui/#tenants-display`) before shipping.

## Post-Phase-A2 note — hybrid-dev tech-user needs `MobileApp` role

Phase A2 tightened `ScannerService` from `@requires: 'authenticated-user'` to `@requires: 'MobileApp'`. Production traffic through the approuter is unaffected (the approuter route already required `MobileApp` at ingress). But **local hybrid-dev with tech-user Basic auth needs the tech-user's `TenantSettings.techUsers` entry to include `MobileApp` in its role list**, otherwise the srv layer returns 403 on `/scanner/*` calls.

Format: `svc-account:pass:MobileApp` (or `svc-account:pass:Admin,MobileApp` for multi-role tech users).

## Related docs

- [MTA Deployment Runbook](mta-deployment.md) — see Step 4 for the `cf update-service` command in context.
- [Master auth-parity spec (#809)](../../superpowers/specs/2026-07-03-809-authorization-parity-design.md).
