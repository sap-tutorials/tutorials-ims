# Authentication & Authorization Architecture

## Identity Provider

The platform uses the **default SAP ID Service** (`accounts.sap.com`) as its Identity Provider. This is the shared SAP-managed IDP that supports SAP Universal ID — any user who has registered at account.sap.com can authenticate.

### Why Default IDP (Not Custom IAS)

| Concern | Default SAP ID Service | Custom IAS Tenant |
|---------|----------------------|-------------------|
| Universal ID login | Supported natively | Also supported |
| User provisioning | None needed — open registration | None needed (can federate) |
| Technical users for automation | Not possible (humans only) | Yes — admin-managed |
| Custom branding | No | Yes |
| MFA policies | SAP-managed | Fully configurable |
| Cost/complexity | Zero | Requires tenant setup |

**Decision:** Default IDP is sufficient because:
- The app is public-facing — anyone with a Universal ID should be able to use it
- No need for custom login pages or MFA policies
- Automation uses service keys with `client_credentials` (no IDP involved)
- Technical user needs are minimal and handled via XSUAA directly

### When to Reconsider

Switch to a custom IAS tenant if you later need:
- Corporate SSO federation (customer IDPs via SAML/OIDC)
- Named technical users with audit identity (beyond service keys)
- Certificate-based automation auth with rotation policies
- Social login (Google, GitHub, etc.)
- Fine-grained conditional access rules

---

## XSUAA Configuration

The XSUAA instance (`tutorials-xsuaa`) is configured via `xs-security.json`.

### Scopes

| Scope | Purpose | Who gets it |
|-------|---------|-------------|
| `Admin` | Full admin access (CRUD on all entities) | Manual role collection assignment |
| `SuperAdmin` | Publish/unpublish operations | Manual role collection assignment |
| `ContentAuthor` | Create and edit content | Manual role collection assignment |
| `DeveloperApp` | Legacy scope (unused for public access) | Not required for normal users |
| `MobileApp` | Mobile app features | Manual role collection assignment |
| `DisplayApp` | Read-only UI access (event monitors) | Manual role collection assignment |
| `ConsolidationScope` | Account merge operations | Service-to-service (SCI) |
| `Everyone` | Baseline access marker | Manual role collection assignment |

### Role Collections

| Role Collection | Includes | Assigned to |
|----------------|----------|-------------|
| Tutorials SuperAdmin | SuperAdmin + Admin + Display + Developer + Everyone | Platform operators |
| Tutorials Admin | Admin + Display + Developer + Everyone | Content administrators |
| Tutorials Developer | DeveloperApp + Everyone | Not needed for public access |
| Tutorials Display | Display + Everyone | Event monitor operators |

### Important: Role Collections Are NOT Auto-Assigned

Users who log in via SAP ID Service do **not** automatically receive any role collection. Role collections must be manually assigned in BTP Cockpit (Security → Role Collections → assign user) or auto-assigned via Trust Configuration settings.

This is why public-facing services use `@requires: 'authenticated-user'` instead of scope-based authorization — see [Service Authorization](#service-authorization) below.

---

## Service Authorization

### CAP `@requires` Annotations

| Service | Path | `@requires` | Access Level |
|---------|------|-------------|--------------|
| **DeveloperService** | `/api` | `'authenticated-user'` | Any logged-in user |
| **ScannerService** | `/scanner` | `'authenticated-user'` | Any logged-in user |
| **AdminService** | `/admin` | `'Admin'` | Scope-protected |
| **DisplayService** | `/display` | `'DisplayApp'` | Scope-protected |
| **ConsolidationService** | `/api/v1` | `'ConsolidationScope'` | Service-to-service |
| **SearchService** | `/search` | `'any'` | Fully public (no auth) |
| **EventStreamService** | `/event-stream` | `'any'` | Fully public (no auth) |

### Understanding `@requires` Values

- **`'any'`** — No authentication required. Anyone can call the endpoint, even without a JWT. Use for truly public data (search, event streams, build catalog).
- **`'authenticated-user'`** — A valid JWT must be present, but no specific scope is needed. The user just needs to have logged in successfully. This is the standard pattern for public apps where any registered user should have access.
- **`'ScopeName'`** — The JWT must contain this specific scope, which requires the user to have a role collection assigned that includes a role template referencing that scope. Use for admin/operational endpoints.

### Why DeveloperService Uses `authenticated-user`

The DeveloperService is the main public-facing API for tutorial progress tracking. It uses `'authenticated-user'` rather than the `'DeveloperApp'` scope because:

1. **Scalability** — millions of community users should be able to track progress without admin intervention
2. **No provisioning** — users don't need a role collection assigned in BTP Cockpit
3. **Identity is sufficient** — the JWT's `sub` claim provides the user identity needed for progress tracking; no elevated privilege is required to complete tutorial steps
4. **Graceful first-use** — the service handles unknown users by returning empty progress, allowing the frontend to show "log in to start tracking"

---

## Authentication Flows

### Public Tutorial Browsing (Unauthenticated)

```
User → AppRouter → /content/tutorials/:slug → CAP content-store → HANA BLOB → HTML
User → /search → SearchService → results (no auth)
User → /build/catalog → catalog JSON (no auth)
```

No login required. Tutorial content, search, and catalog data are fully public.

### Progress Tracking (Authenticated)

```
User clicks "Complete Step"
  → AppRouter detects no session
    → Redirect to SAP ID Service login
      → User authenticates with Universal ID
        → XSUAA issues JWT (sub = user's unique ID)
          → AppRouter sets session cookie
            → Request forwarded to CAP with JWT
              → DeveloperService checks 'authenticated-user' ✓
                → req.user.id = JWT sub claim
                  → Progress stored against Users.uuid
```

### Admin Operations (Scope-Protected)

```
Admin navigates to /admin-ui/
  → AppRouter requires auth → login redirect
    → After login, JWT includes scopes IF role collection assigned
      → AdminService checks 'Admin' scope in JWT
        → Access granted or 403 Forbidden
```

Admins must have the "Tutorials Admin" or "Tutorials SuperAdmin" role collection manually assigned in BTP Cockpit.

---

## Automation & Service-to-Service Auth

### Client Credentials (No IDP Involved)

For CI/CD pipelines and automation scripts that need to call protected CAP endpoints:

```bash
# Create a service key for the XSUAA instance
cf create-service-key tutorials-xsuaa automation-key

# Fetch token using client credentials grant
curl -X POST "$XSUAA_URL/oauth/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET"
```

The token's scopes come from the `authorities` array in `xs-security.json` (if configured) or can be limited per service key.

### Content Publishing

Content publishing uses a simpler bearer token mechanism:

```bash
# Set in CI secrets and on the deployed app
export CONTENT_API_KEY="tutorials-content-publish-2024"

# The publish script includes this as Authorization: Bearer header
npm run publish-content
```

This is validated in `srv/lib/content-store.js` — not through XSUAA. It's a deliberate simplification for the build pipeline.

### Adding `authorities` for Automation (If Needed)

To grant scopes to service keys via `client_credentials`, add to `xs-security.json`:

```json
"authorities": [
  "$XSAPPNAME.SuperAdmin",
  "$XSAPPNAME.ContentAuthor"
]
```

This is NOT currently configured. Add it only if automation scripts need XSUAA-scoped access beyond the `CONTENT_API_KEY` pattern.

---

## User Identity in CAP

### How Users Are Identified

```js
// In any CAP service handler:
const user = req.user;         // CAP User object
const userId = req.user.id;    // JWT 'sub' claim (Universal ID unique identifier)
```

The `sub` claim from the JWT maps to `Users.uuid` in the database. This is stable across sessions and devices for the same Universal ID account.

### First-Time User Handling

The DeveloperService handles unknown users gracefully:

```js
const dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
if (!dbUser) return { completedSteps: [], points: 0, badges: [] };
```

A User record is created lazily on first meaningful interaction (e.g., completing a step), not on first login.

---

## Security Boundaries Summary

```
┌──────────────────────────────────────────────────────┐
│ PUBLIC (no auth)                                      │
│  /content/tutorials/*   Tutorial HTML from HANA      │
│  /search/*              Full-text search             │
│  /event-stream/*        WebSocket events             │
│  /build/catalog         Build pipeline data          │
│  /build/navigator       Navigation metadata          │
├──────────────────────────────────────────────────────┤
│ AUTHENTICATED (valid JWT, any user)                   │
│  /api/*                 Progress tracking, steps     │
│  /scanner/*             QR code scanner              │
├──────────────────────────────────────────────────────┤
│ SCOPE-PROTECTED (specific role collection required)   │
│  /admin/*               Admin CRUD (Admin scope)     │
│  /display/*             Event monitors (DisplayApp)  │
│  /api/v1/*              Account merge (Consolidation)│
├──────────────────────────────────────────────────────┤
│ CUSTOM TOKEN                                         │
│  POST /content/publish  CONTENT_API_KEY bearer       │
│  POST /content/rollback CONTENT_API_KEY bearer       │
└──────────────────────────────────────────────────────┘
```

---

## Future Considerations

### If You Need Finer-Grained Control on DeveloperService

Add `@restrict` annotations at the entity/action level without changing the service-level `@requires`:

```cds
@requires: 'authenticated-user'
service DeveloperService {
  @restrict: [{ grant: 'READ', to: 'authenticated-user' }]
  entity Tutorials as projection on ...;

  @restrict: [{ grant: 'WRITE', to: 'authenticated-user', where: 'user_uuid = $user' }]
  entity TaskRecords as projection on ...;
}
```

### If You Migrate to IAS

1. Create IAS tenant and establish trust with BTP subaccount
2. Configure user federation (SAP ID Service can be an upstream IDP to IAS)
3. Update `oauth2-configuration.redirect-uris` in `xs-security.json`
4. No changes needed to CAP service code — `authenticated-user` works with any trusted IDP
