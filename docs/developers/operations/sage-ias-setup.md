# SAGE IAS Public-Client Setup Runbook

This runbook provisions a **dedicated IAS public-client instance** (`tutorials-sage-identity`) for the SAGE VS Code extension. SAGE authenticates to IAS via secret-less PKCE (which IAS supports; XSUAA cannot be a public client) and then calls the isolated `srv-sage` backend.

This is a **Tom-run, out-of-band** provisioning step — no `cf` commands are scripted into version control. The resulting `clientid` and IAS tenant URL are needed for Task 6 (live sign-in verification) and for the SAGE extension's `imsAuth.ts` configuration.

---

## Why a dedicated instance?

SAGE gets its own `tutorials-sage-identity` instance rather than reusing the shared `tutorials-identity` for audience isolation: an IAS token minted for SAGE's `clientid` cannot be accepted by the MCP or browser surfaces, and vice versa. This mirrors how `tutorials-srv-mcp` is isolated from `tutorials-srv`.

---

## Prerequisites

- `cf login` targeting the correct space (re-check `cf target` before every mutating command — see [ias-setup.md § CF target drift](ias-setup.md))
- The IAS service plan `application` must be entitled in the subaccount

---

## Step 1 — Verify CF target before provisioning

```bash
cf target
# Confirm: space = tutorials-system/dev  (for DEV)
#          space = tutorials-system/prod (for PROD)
# If wrong: cf target -o tutorials-system -s dev
```

---

## Step 2 — Create the SAGE IAS instance

Run **once per space** (DEV and PROD are separate instances, yielding separate `clientid` values).

### DEV

```bash
cf create-service identity application tutorials-sage-identity -c '{
  "oauth2-configuration": {
    "grant-types": [
      "authorization_code_pkce_s256",
      "refresh_token"
    ],
    "public-client": true,
    "redirect-uris": [
      "vscode://sap-tutorials.sage-tutorial-extension/**",
      "http://localhost:*/oauth/callback",
      "http://127.0.0.1:*/oauth/callback"
    ]
  }
}'
```

### PROD

```bash
cf target -o tutorials-system -s prod
cf create-service identity application tutorials-sage-identity -c '{
  "oauth2-configuration": {
    "grant-types": [
      "authorization_code_pkce_s256",
      "refresh_token"
    ],
    "public-client": true,
    "redirect-uris": [
      "vscode://sap-tutorials.sage-tutorial-extension/**",
      "http://localhost:*/oauth/callback",
      "http://127.0.0.1:*/oauth/callback"
    ]
  }
}'
```

**Configuration notes:**

| Field | Value | Reason |
|---|---|---|
| `grant-types` | `authorization_code_pkce_s256`, `refresh_token` | PKCE-only; `client_credentials` intentionally omitted — SAGE is a user-facing client, not M2M |
| `public-client` | `true` | No client secret ever — matches the PKCE contract; XSUAA cannot do this, IAS can |
| `redirect-uris` | `vscode://sap-tutorials.sage-tutorial-extension/**` | VS Code custom-scheme callback (required for PKCE in-extension) |
| `redirect-uris` | `http://localhost:*/oauth/callback`, `http://127.0.0.1:*…` | Local dev / test runner loopback |

> **Do NOT add `client_credentials` to this instance** — SAGE is a user-facing VS Code extension. The local `localhost` URIs are for development and test; they are harmless for a public client.

---

## Step 3 — Read back the clientid and IAS tenant URL

After creation, extract the credentials that the extension and backend need.

```bash
# Create a temporary service key to read the credentials
cf create-service-key tutorials-sage-identity sk-read

# Strip the CF header so jq can parse
cf service-key tutorials-sage-identity sk-read | sed -n '/{/,$p' > sage-sk.json

# Print the values you need
jq -r '"clientid: " + .credentials.clientid'  sage-sk.json
jq -r '"url:      " + .credentials.url'       sage-sk.json

# Clean up — the key is not needed further; credentials are read once
cf delete-service-key tutorials-sage-identity sk-read -f
rm -f sage-sk.json
```

The `url` field is the IAS tenant root (e.g. `https://atxgsg7zi.accounts.ondemand.com`).  
The `clientid` is the OAuth2 client identifier SAGE presents in its PKCE flow.

Record both values:

| Value | Where used |
|---|---|
| `clientid` (DEV) | `imsAuth.ts` `clientId` field for the DEV/testing build of SAGE |
| `clientid` (PROD) | `imsAuth.ts` `clientId` field for the stable PROD build of SAGE |
| `url` (IAS tenant root) | `authUrl` → `<url>/oauth2/authorize`, `tokenUrl` → `<url>/oauth2/token` |

> **Never commit these values to source** — they are runtime config in the extension's `package.json` contributes or environment-specific build constants, not in VCS.

---

## Step 4 — Add or update redirect URIs (if updating an existing instance)

If the instance already exists and you need to add or change redirect URIs (e.g. a new VS Code extension ID), use `cf update-service`. Always carry forward all existing URIs additively — omitting a URI removes it and breaks live sessions:

```bash
cf update-service tutorials-sage-identity -c '{
  "oauth2-configuration": {
    "grant-types": [
      "authorization_code_pkce_s256",
      "refresh_token"
    ],
    "public-client": true,
    "redirect-uris": [
      "vscode://sap-tutorials.sage-tutorial-extension/**",
      "http://localhost:*/oauth/callback",
      "http://127.0.0.1:*/oauth/callback"
    ]
  }
}'
```

> **Note:** `cf update-service -c` replaces the entire `oauth2-configuration` object. Always include the full desired config in a single call, not just the delta.

---

## Step 5 — Adopt the instance in `mta-sage.yaml`

The `srv-sage` MTA adopts `tutorials-sage-identity` as an `existing-service` (the same pattern used by the MCP MTA for `tutorials-identity`). The relevant stanza in `mta-sage.yaml` will look like:

```yaml
resources:
  - name: tutorials-sage-identity
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: tutorials-sage-identity
```

And the `tutorials-srv-sage` module binds it:

```yaml
modules:
  - name: tutorials-srv-sage
    ...
    requires:
      - name: tutorials-sage-identity
      - name: tutorials-hana
      - name: tutorials-xsuaa   # hybrid fallback
```

**Deploy the main MTA before the SAGE MTA** on a fresh space — `tutorials-sage-identity` must exist before `mta-sage.yaml` can adopt it. On an existing space the instances are already there; order does not matter.

---

## Step 6 — Verify the instance is a public client

Confirm the IAS metadata endpoint shows `none` as a supported `token_endpoint_auth_method` (the public-client signal):

```bash
cf service-key tutorials-sage-identity sk-verify | sed -n '/{/,$p' > sage-sk-v.json
TENANT_URL=$(jq -r .credentials.url sage-sk-v.json)

curl -s "$TENANT_URL/.well-known/openid-configuration" \
  | jq '.token_endpoint_auth_methods_supported'
# Expected to include "none" — confirms public-client mode
# XSUAA does NOT include "none" (that's the root cause we're working around)

cf delete-service-key tutorials-sage-identity sk-verify -f
rm -f sage-sk-v.json
```

If `none` is absent, the instance was created without `"public-client": true` or the update did not take. Re-run Step 2 (`cf update-service ...`) with the correct config.

---

## Rollback / decommission

```bash
# Delete the instance (removes all service keys and bindings first)
cf delete-service tutorials-sage-identity -f
```

The main `tutorials-srv` and `tutorials-srv-mcp` are unaffected — they bind `tutorials-identity`, not `tutorials-sage-identity`.

---

## References

- Design spec: [`docs/superpowers/specs/2026-11-19-sage-ias-isolated-backend-design.md`](../../superpowers/specs/2026-11-19-sage-ias-isolated-backend-design.md)
- Shared IAS + M2M runbook: [`docs/developers/operations/ias-setup.md`](ias-setup.md) — covers `tutorials-identity`, M2M service keys, CF-target-drift warning
- MTA deployment guide: [`docs/developers/operations/mta-deployment.md`](mta-deployment.md) — covers `existing-service` adoption and deploy order
- IAS PKCE public-client constraint: `mta-mcp.yaml:64` comment + design spec §"Root cause"
