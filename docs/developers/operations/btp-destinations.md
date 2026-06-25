# BTP Destinations — SCI and NGDS

The platform talks to two SAP-internal systems through BTP Destinations: **SCI** (SAP Cloud Identity, for user-profile lookups during migration / Java IMS parity) and **NGDS** (Next-Generation Data Service, for tutorial-completion analytics events). Each system has separate destinations for the **dev/QA** and **prod** subaccounts.

This runbook documents the destination names, what they're used for, and — most importantly — where to retrieve the user passwords when a destination has to be (re)created or its credentials rotated.

## At a glance

| System | Subaccount scope | BTP Destination name | Used by |
|---|---|---|---|
| SCI  | dev / qa | `IMS_DEV_QA_SCI`  | Java IMS profile enrichment; CAP cutover scripts (`migrate-user-progress.js`) |
| SCI  | prod     | `IMS_PROD_SCI`    | Java IMS profile enrichment; CAP cutover scripts (`migrate-user-progress.js`) |
| NGDS | dev / qa | `IMS_DEV_QA_NGDS` | `cds.requires.ngds` → `POST /ngds/developers/ims` from `srv/lib/ngds-client.js` |
| NGDS | prod     | `IMS_PROD_NGDS`   | `cds.requires.ngds` → `POST /ngds/developers/ims` from `srv/lib/ngds-client.js` |

The CDS-level destination key in [package.json](../../../package.json) (`cds.requires.ngds.credentials.destination`) is the **logical** name (`ngds-destination`); the **physical** BTP destination it resolves to is the one assigned at the subaccount level (`IMS_DEV_QA_NGDS` or `IMS_PROD_NGDS`). If you rename the physical destination, also update the `destination` field in `package.json`.

See also: [External Integrations](../reference/external-integrations.md) for the full integration map and [Authentication](../architecture/authentication.md#user-resolution-cap-nodejs) for why CAP no longer calls SCI on every request (only during migration cutover).

## Where to get the user passwords (PassVault)

Passwords for the technical users behind these destinations are stored in SAP's internal **PassVault** (`cmp.wdf.sap.corp/passvault`). Use the entry that matches the destination you're editing — do **not** copy a password between dev/QA and prod, even if they look interchangeable in the cockpit.

| Destination       | PassVault entry  | Link |
|---|---|---|
| `IMS_DEV_QA_SCI`  | `IMS_DEV_QA_SCI` | <https://cmp.wdf.sap.corp/passvault/#/pwd/0000633975> |
| `IMS_PROD_SCI`    | `IMS_PROD_SCI`   | <https://cmp.wdf.sap.corp/passvault/#/pwd/0000633988> |
| `IMS_DEV_QA_NGDS` | `IMS_DEV_QA_NGDS`| <https://cmp.wdf.sap.corp/passvault/#/pwd/0000633995> |
| `IMS_PROD_NGDS`   | `IMS_PROD_NGDS`  | <https://cmp.wdf.sap.corp/passvault/#/pwd/0000633977> |

The PassVault record IDs (`0000633975` etc.) are stable across rotations — the URL points at the **record**, not at a specific password version. After a rotation, the same URL surfaces the new value; bookmark these, not the secret itself.

Access to PassVault requires being on the SAP corporate network (or VPN) and membership in the IMS team's PassVault group. If you get a 403, ping the team lead for group membership; the records themselves don't need to be re-created.

## When to touch a destination

You normally only edit these destinations in three situations:

1. **Initial setup of a new subaccount** (e.g. a fresh dev landscape, or the prod cutover) — create all four destinations from scratch using the matching PassVault password.
2. **Password rotation by the SCI / NGDS owner** — PassVault is updated by the upstream team; copy the new value into the BTP cockpit destination's `Password` field and Save. No app restart is required: the destination service hands out fresh credentials on each lookup.
3. **Subaccount export / import** — the BTP cockpit's "Export" / "Import" buttons on the Destinations page **redact the password field** in the exported JSON (written as `<removed>`). When importing, you MUST paste the real password from PassVault back into each destination before the connection works. See the matching gotcha in [docs/developers/reference/external-integrations.md](../reference/external-integrations.md) and `feedback_btp_destination_export_redacts_password.md` in the project memory.

## Steps — editing a destination

1. Open the BTP cockpit for the target subaccount → **Connectivity** → **Destinations**.
2. Click the destination row (one of the four names above).
3. Open the matching PassVault entry from the table above. Copy the password.
4. Paste into the destination's **Password** field. Leave URL, User, Authentication (Basic), and Proxy Type (Internet) unchanged.
5. Click **Save**.
6. Verify with **Check Connection** — expect HTTP 200, 401 (auth reached, wrong scope is fine for SCI ping), or 405 (NGDS rejects GET, which means the connection works). A connection error or HTTP 407 means the password didn't take.

## Verifying end-to-end

- **NGDS** — trigger an admin retry from `/admin-ui/#ngds-failed-messages` (or call `POST /admin/sendToNgds` with a known `taskRecordLegacyId`). Success means the row leaves `NGDSFailedMessages` with `status = SENT`; failure re-queues with the new error message.
- **SCI** — run `node scripts/migrate-user-progress.js --probe-sci` (cutover-window only) against the target IMS REST endpoint. A 200 with a populated profile confirms SCI resolution is working through the destination.

## Cross-links

- [External Integrations](../reference/external-integrations.md) — NGDS / SCI roles in the broader integration map
- [Migration from IMS](migration-from-ims.md) — when the SCI destinations are still on the critical path
- [Authentication](../architecture/authentication.md) — why CAP doesn't call SCI per request
- [Secrets tracking](secrets-tracking.md) — for adding these passwords to the `Secrets` HANA entity so they surface in the admin notifications popover before they expire
