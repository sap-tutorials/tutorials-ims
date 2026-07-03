# Production Readiness — Missing Services & Entitlements

This document lists BTP services currently marked `optional: true` in `mta.yaml` that need to be provisioned for production.

---

## Services Marked Optional in DEV

These services are skipped during MTA deployment if the service instance doesn't exist. They are required for full production functionality.

| # | MTA Resource Name | BTP Service | Plan | Purpose |
|---|-------------------|-------------|------|---------|
| 1 | `tutorials-mail` | User-Provided Service | n/a | Outbound email notifications — contributor stale-content alerts, prize fulfillment, account merge confirmations. Provides SMTP credentials (`mail_host`, `mail_port`, `mail_user`, `mail_password`) consumed by `srv/lib/mail-client.js` via `@sap/xsenv`. |
| 2 | `tutorials-audit-log` | Audit Log Service (`auditlog`) | `premium` | Compliance logging for `@PersonalData`-annotated entities (Users, UserMetaData, TaskRecords). Captures data access and modification events. |
| 3 | `tutorials-cloud-logging` | SAP Cloud Logging (`cloud-logging`) | `standard` | OpenTelemetry trace/metric export via gRPC. Powers observability dashboards and distributed tracing in production. |

---

## Entitlements Required in Production Subaccount

Navigate to **BTP Cockpit → Subaccount → Entitlements → Configure Entitlements → Add Service Plans**:

| Service           | Plan to Add | Quota |
|-------------------|-------------|-------|
| Audit Log Service | premium     | 1     |
| SAP Cloud Logging | standard    | 1     |

> **Note:** The `premium` audit log plan enables the Audit Log Retrieval API. The `oauth2` plan is additionally needed if you want the Audit Log Viewer UI application — that's a separate entitlement.

---

## Service Instance Creation

After entitlements are assigned:

```bash
# Target the production space
cf target -o <org> -s production

# 1. Mail (User-Provided Service — no marketplace entitlement needed)
cf cups tutorials-mail -p '{"mail_host":"smtp.example.com","mail_port":587,"mail_user":"user@example.com","mail_password":"<password>"}'

# 2. Audit Log (premium = includes retrieval API)
cf create-service auditlog premium tutorials-audit-log

# 3. Cloud Logging (with OTLP ingest enabled)
cf create-service cloud-logging standard tutorials-cloud-logging -c '{"ingest_otlp":{"enabled":true}}'
```

---

## MTA Configuration for Production

For production deployments, consider removing `optional: true` so a missing service fails the deploy loudly rather than silently degrading:

**Option A:** Edit `mta.yaml` directly (removes optional for all environments):
```yaml
- name: tutorials-audit-log
  type: org.cloudfoundry.managed-service
  # optional: true  ← remove this line
  parameters:
    service: auditlog
    service-plan: premium
```

**Option B (recommended):** Use an MTA extension file (`deploy/prod.mtaext`):
```yaml
_schema-version: 3.3.0
ID: tutorials-ims-prod
extends: tutorials-ims

resources:
  - name: tutorials-mail
    optional: false
  - name: tutorials-audit-log
    optional: false
  - name: tutorials-cloud-logging
    optional: false
```

Then deploy with:
```bash
cf deploy mta_archives/tutorials-ims_1.0.0.mtar -e deploy/prod.mtaext
```

---

## Post-Provisioning Verification

```bash
# Verify all services exist and are bound
cf services | grep tutorials

# Check srv app has all bindings
cf env tutorials-srv | grep -E "mail|audit|cloud-logging"

# Verify audit logging works (should see entries after any user data access)
cf service tutorials-audit-log  # check status is "create succeeded"

# Verify cloud logging endpoint
cf service-key tutorials-cloud-logging tutorials-cloud-logging-key
# → Should show dashboards-endpoint URL
```

---

## Additional Production Considerations

### Already Provisioned (Non-Optional)

These services are **not** optional and should already exist in production:

| MTA Resource Name | Service | Plan |
|-------------------|---------|------|
| `tutorials-hana` | SAP HANA Cloud (`hana`) | `hdi-shared` |
| `tutorials-xsuaa` | SAP Authorization & Trust Mgmt (`xsuaa`) | `application` |
| `tutorials-destination` | SAP Destination Service (`destination`) | `lite` |
| `tutorials-html5-repo-host` | HTML5 Application Repository (`html5-apps-repo`) | `app-host` |
| `tutorials-html5-repo-rt` | HTML5 Application Repository (`html5-apps-repo`) | `app-runtime` |

### Environment Variables for Production

```bash
# Content publishing authentication
cf set-env tutorials-srv CONTENT_API_KEY "<secure-random-key>"

# Do NOT set EXPOSE_CAP_UI on production (keeps Swagger/index blocked)
# cf unset-env tutorials-srv EXPOSE_CAP_UI  ← ensure this is NOT set

cf restart tutorials-srv
```

### XSUAA Configuration

Ensure `xs-security.json` scopes and role collections are created in the production subaccount. The MTA deployer handles this automatically, but verify:

```bash
cf service-key tutorials-xsuaa tutorials-xsuaa-key | grep -A2 "xsappname"
```
