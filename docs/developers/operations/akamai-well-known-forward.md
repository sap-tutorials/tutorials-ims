# Akamai edge: forward `/.well-known/*` to origin

## Problem

On `developers.sap.com`, Akamai returns **403** for every `/.well-known/*` path
except `security.txt` (verified: `Server: AkamaiGHost` on the 403). The origin
approuter serves the MCP OAuth discovery documents correctly, but the edge blocks
them before they reach origin, so MCP clients cannot auto-discover the server.

## Request to the Akamai/edge team

Forward the following origin paths on `developers.sap.com` to the approuter origin
(pass-through, no edge auth, cacheable per origin `Cache-Control`):

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/openid-configuration`
- `/.well-known/mcp.json`
- `/.well-known/security.txt` (keep working; origin now also serves it)

Simplest rule: forward the whole `/.well-known/*` prefix to origin.

## Verification after the rule lands

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://developers.sap.com/.well-known/oauth-authorization-server   # expect 200
curl -s https://developers.sap.com/.well-known/oauth-protected-resource | jq .
curl -s -D - -o /dev/null https://developers.sap.com/mcp-auth/api | grep -i www-authenticate                 # expect resource_metadata pointer
```

The `/mcp-auth/api` check exercises a separate path (`/mcp-auth/*`, which already reaches origin) and is not covered by the requested `/.well-known/*` edge-forward rule; it is included only to confirm the `WWW-Authenticate` discovery pointer end-to-end.

DEV has no Akamai in front, so all paths work there as soon as the approuter deploys.
