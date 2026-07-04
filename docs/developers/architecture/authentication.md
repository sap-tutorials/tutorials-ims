---
title: Authentication and Authorization
description: How user identity flows from browser to database — XSUAA, JWT, user resolution, scopes.
---

# Authentication and Authorization

> Source: merged from former authentication-primer.md and authentication-architecture.md, 2026-05-25.

## Primer

How user identity flows from browser to database in the tutorials platform, covering XSUAA configuration, JWT token structure, user resolution, and the differences between the Java IMS and CAP implementations.

### Token Flow

```
Browser → AppRouter → XSUAA (SAP IDP) → JWT issued
  → AppRouter forwards request + JWT to CAP srv
    → CAP extracts user identity from JWT
      → Service handler resolves DB user from identity
```

The AppRouter handles the OAuth2 login flow via XSUAA. Once authenticated, every request to the backend carries a Bearer JWT issued by XSUAA. The backend never handles login directly — it only validates and reads the token.

### XSUAA Configuration

Both systems bind to the **same XSUAA service instance** (`xsuaa-imsdev` / `xsuaa-imsqa` / `xsuaa-imsprod`). The `xs-security.json` in this repo is reference documentation only — deployment uses `org.cloudfoundry.existing-service` to bind the pre-existing instance.

#### Scopes

| Scope | Purpose | Consumers |
|-------|---------|-----------|
| `Admin` | Full admin access (CRUD, GDPR, notifications) | Internal team |
| `ContentAuthor` | Create/edit content | Tutorial authors |
| `DeveloperApp` | Tutorial progress, step completion | End users (developers.sap.com) |
| `MobileApp` | Mobile app features | SAP Events mobile app |
| `DisplayApp` | Read-only UI access (leaderboards) | Event display monitors |
| `ConsolidationScope` | Account merge operations | SCI technical user only |
| `Everyone` | Baseline access | All authenticated users |

#### Role Templates

Roles bundle scopes. Assignment happens in BTP cockpit via role collections:

- **Admin** = `Admin` + `Everyone`
- **ContentAuthor** = `ContentAuthor` + `DisplayApp` + `Everyone`
- **DeveloperApp** = `DeveloperApp` + `Everyone`
- **MobileApp** = `MobileApp` + `DisplayApp` + `Everyone`
- **DisplayApp** = `DisplayApp` + `Everyone`
- **ConsolidationScope** = `ConsolidationScope` (no `Everyone` — technical user)

### JWT Token Structure

The XSUAA JWT contains these identity-relevant claims:

```json
{
  "user_uuid": "a1b2c3d4-...",      // SAP IDP Global User ID (stable across systems)
  "email": "user@example.com",
  "given_name": "Alice",
  "family_name": "Developer",
  "user_name": "alice@example.com",  // Login name (usually email)
  "scope": ["tutorials-ims.DeveloperApp", "tutorials-ims.Everyone"],
  "xs.user.attributes": {
    "email": ["user@example.com"],
    "given_name": ["Alice"],
    "family_name": ["Developer"]
  }
}
```

The **`user_uuid`** claim is the primary identity key. It is the SAP IDP "Global User ID" — stable, unique, and consistent across all BTP services for the same person. This is what both systems use to identify users in the database.

### User Resolution: Java IMS

The Java IMS uses a multi-layer identity chain:

#### 1. AuditUserFilter (Servlet Filter)

Runs on **every** request before controllers execute:

```java
// AuditUserFilter.java
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
if (auth instanceof JwtAuthenticationToken token) {
    Jwt jwt = token.getToken();
    userUuid = jwt.getClaimAsString("user_uuid");  // ← primary identity
}
```

#### 2. Technical User Mapping

Before resolving the user in the database, the filter checks `AppTechUsers` — a configured mapping of technical service account IDs to real user identifiers:

```java
Map<String, String> techUsers = appTechUsers.getTechUsersMapping();
if (techUsers.containsKey(userUuid)) {
    userUuid = techUsers.get(userUuid);  // remap technical → real account
}
```

This handles cases where a technical service (like the SCI consolidation user or the AEM proxy) calls the API on behalf of a real user. The token identifies the technical account, but the mapping redirects to the actual user.

#### 3. User Resolution + Auto-Creation

```java
// UserResolverHelperImpl.java
User user = userRepository.findOneBySapId(accountNumber);
if (user == null) {
    User newUser = new User(BasicUUIDGenerator.generate(), accountNumber);
    user = userRepository.save(newUser);
}
```

If the user doesn't exist in the database, they're created on first access with their `user_uuid` as the `sapId` field.

#### 4. SCI Enrichment (Optional)

For display purposes (leaderboards, export), the Java app calls the **SCI** (SAP Cloud Identity) service to fetch rich user profiles:

```java
sciClient.getUser(accountNumber);  // Returns displayName, email, etc.
```

This is a network call to the BTP Identity Directory via the Destination service. It provides richer profile data than what's in the JWT.

#### 5. Thread-Local Context

The resolved user's internal DB ID is stored in a thread-local for downstream access:

```java
AuditUserContext.setUserId(resolved.get().getId().toString());
```

This means any code in the request chain can access the current user without re-resolving.

### User Resolution: CAP Node.js

CAP handles most of this automatically via its XSUAA integration:

#### 1. Automatic JWT Processing

CAP's `@sap/cds` framework automatically validates the JWT and populates `req.user`:

```javascript
const user = req.user;
// user.id    → "user_uuid" claim (the SAP IDP Global User ID)
// user.attr  → { email, given_name, family_name, ... } from xs.user.attributes
// user.is('Admin') → scope check
```

No filter needed — CAP does this for every authenticated request.

#### 2. Database User Lookup + Auto-Creation

In service handlers (e.g., `completeStep`):

```javascript
let dbUser = await SELECT.one.from(Users).where({ uuid: user.id });
if (!dbUser) {
    await INSERT.into(Users).entries({
        uuid: user.id,
        legacyId: await getNextLegacyId('Users', db),
        email: user.attr?.email || '',
        firstName: user.attr?.given_name || '',
        lastName: user.attr?.family_name || ''
    });
    dbUser = await SELECT.one.from(Users).where({ uuid: user.id });
}
```

Same auto-creation behavior as Java, but:
- Profile fields (email, name) come from JWT attributes directly — no SCI call needed
- Resolution is lazy (only when the handler needs the DB user), not on every request

#### 3. Authorization

CDS annotations enforce scope requirements at the service level:

```cds
service DeveloperService @(requires: 'DeveloperApp') { ... }
service AdminService @(requires: 'Admin') { ... }
service DisplayService @(requires: 'DisplayApp') { ... }
```

CAP rejects requests without the required scope before the handler runs.

### Key Differences

| Aspect | Java IMS | CAP Node.js |
|--------|----------|-------------|
| JWT extraction | Manual (`AuditUserFilter`) | Automatic (`req.user`) |
| Identity claim | `user_uuid` from JWT | `req.user.id` (same claim) |
| Technical user mapping | `AppTechUsers` config bean | `TECH_USERS` env var + middleware |
| User auto-creation | Every request (filter) | Lazy (in handler) |
| Profile enrichment | SCI network call | JWT attributes (no call) |
| Authorization | Spring Security + annotations | CDS `@requires` |
| Request context | Thread-local (`AuditUserContext`) | `req.user` per-request |

### Technical User Authentication (Basic Auth Bypass)

Technical service accounts authenticate via HTTP Basic Auth instead of XSUAA JWTs. This handles CI/CD pipelines, the SCI consolidation service, and other machine-to-machine callers that cannot perform an OAuth2 login flow.

#### Java IMS Implementation

`AppTechUsers` is a Spring `@ConfigurationProperties` bean with two maps:

1. **`app.tech-users`** (username → password) — Credentials for Basic Auth. The `BasicAuthBypassFilter` validates incoming Basic Auth headers against this map. Valid credentials grant `SCOPE_Admin` authority without needing a JWT.

2. **`app.tech-users-mapping`** (tech_id → real_uuid) — Identity remapping. After Basic Auth succeeds, the `AuditUserFilter` checks if the authenticated identity should be remapped to a different real user for audit/context purposes.

Values are configured via Cloud Foundry environment variables (not committed to source).

#### CAP Implementation

The middleware at [srv/lib/tech-user-auth.js](../../../srv/lib/tech-user-auth.js) runs before CAP's auth middleware (registered via `cds.on('bootstrap')`). It:

1. Checks for `Authorization: Basic ...` header
2. Validates credentials against `TECH_USERS` environment variable
3. Optionally remaps identity via `TECH_USERS_MAPPING` environment variable
4. Sets `req.user` as a `cds.User` with configured roles — CAP then uses this for `@requires` checks

If no Basic Auth header is present, or credentials don't match, the middleware passes through to CAP's standard JWT authentication.

#### Configuration

**`TECH_USERS`** — Semicolon-separated entries of `username:password:role1,role2`:

```
TECH_USERS="ci-bot:s3cret:Admin;sci-consolidation:p4ss:ConsolidationScope;display-svc:token:DisplayApp"
```

- If roles are omitted, defaults to `Admin`
- Passwords must not contain colons (format limitation of the delimiter)

**`TECH_USERS_MAPPING`** — Semicolon-separated entries of `tech_username:target_uuid`:

```
TECH_USERS_MAPPING="sci-consolidation:a1b2c3d4-real-user-uuid"
```

When a mapped tech user authenticates, `req.user.id` is set to the target UUID instead of the username. The original tech username is preserved in `req.user.attr.techUser` for audit purposes.

#### Deployment

Set these as environment variables on the `tutorials-srv` Cloud Foundry app:

```bash
cf set-env tutorials-srv TECH_USERS "ci-bot:s3cret:Admin;sci-consolidation:p4ss:ConsolidationScope"
cf set-env tutorials-srv TECH_USERS_MAPPING "sci-consolidation:a1b2c3d4-real-uuid"
cf restage tutorials-srv
```

Or add to `mta.yaml` properties (referencing a credential store for secrets):

```yaml
modules:
  - name: tutorials-srv
    properties:
      TECH_USERS: ~{tech-users-credentials/value}
```

#### How It Differs From Java

| Aspect | Java (`AppTechUsers`) | CAP (`tech-user-auth.js`) |
|--------|----------------------|--------------------------|
| Config source | Spring `application.yaml` properties | Environment variables |
| Auth grant | Always `SCOPE_Admin` | Configurable roles per user |
| Identity mapping | Separate `techUsersMapping` map | Separate `TECH_USERS_MAPPING` env var |
| Middleware position | `BasicAuthBypassFilter` (before Spring Security) | `app.use()` on bootstrap (before CDS auth) |
| Fallthrough | Falls through to JWT auth if no match | Same — passes to CAP JWT if no match |

### Database Schema (Identity Fields)

```cds
entity Users : cuid {
  uuid        : UUID;         // SAP IDP Global User ID (= JWT user_uuid)
  sapId       : String(255);  // Legacy: same as uuid for most users
  legacyId    : Integer64;    // HANA sequence ID for Java IMS compatibility
  email       : String(255);
  firstName   : String(255);
  lastName    : String(255);
  displayName : String(255);
}
```

- `uuid` is the primary identity key, matching `req.user.id` / JWT `user_uuid`
- `sapId` exists for backward compatibility with Java IMS (which used this as the lookup field)
- `legacyId` is the HANA sequence integer ID used by Java IMS consumers

### Public Access + Lazy Login (AppRouter)

Tutorial pages are publicly readable without authentication. Login is triggered on demand when a user wants interactive features (progress tracking, step completion).

#### Route Architecture

```
xs-app.json routes (evaluated top-to-bottom):

/login          → authenticationType: "xsuaa"  (triggers OAuth flow)
/auth/user      → authenticationType: "xsuaa"  (returns user info if logged in)
/admin/*        → authenticationType: "xsuaa"  (admin API)
/display/*      → authenticationType: "xsuaa"  (display API)
/api/v1/*       → authenticationType: "xsuaa"  (consolidation API)
/api/*          → authenticationType: "xsuaa"  (developer API)
/*              → authenticationType: "none"   (static content — PUBLIC)
```

#### Login Flow

```
1. User visits /tutorials/some-tutorial
   → AppRouter serves static HTML (no auth, authenticationType: "none")
   → Frontend shows empty profile icon (no session)

2. User clicks profile icon
   → Frontend navigates to /login (with return URL in browser state)
   → AppRouter route has authenticationType: "xsuaa"
   → AppRouter redirects to SAP IDP authorize endpoint
   → User authenticates (or SSO resolves automatically)
   → SAP IDP redirects back to AppRouter callback
   → AppRouter sets session cookie, redirects to /

3. User is back on the page with valid session
   → Frontend calls GET /auth/user → returns user info
   → Profile icon shows user name/avatar
   → API calls to /api/* now include the session cookie
   → Progress tracking, step completion enabled
```

#### Frontend Auth Detection

The frontend checks authentication state by calling `GET /auth/user`:

```javascript
// On page load
const res = await fetch('/auth/user');
if (res.ok) {
  const user = await res.json();
  // user = { authenticated: true, id, email, givenName, familyName }
  // → show profile, enable interactive features
} else {
  // 401 → not logged in
  // → show empty profile icon, disable write features
}
```

The `/auth/user` route in `xs-app.json` has `authenticationType: "xsuaa"`, so the AppRouter will only forward the request to the CAP backend if the user has a valid session. If not, the AppRouter returns 401 directly (never reaches CAP).

#### Key Design Points

- **Static content is fully public** — no redirect to login, no flash of login page
- **API routes require auth** — the AppRouter enforces XSUAA session before proxying to CAP
- **Login is explicit** — only triggered by user action (clicking profile icon)
- **SSO is transparent** — if the user is already authenticated with SAP IDP (e.g., from another SAP site), the OAuth flow resolves immediately without showing a login form
- **Session cookie** — after login, the AppRouter session cookie persists until the user logs out or the session expires. Subsequent page navigations retain the authenticated state.

### Unauthenticated Endpoints

Two endpoints bypass XSUAA entirely:

| Endpoint                             | Why Unauthenticated                                                     |
|--------------------------------------|-------------------------------------------------------------------------|
| `GET /build/catalog`                 | Called by CI/CD pipeline at build time (no user context)                |
| `WS /socket.io/`, `/ws/event-stream` | Socket.IO transport + anonymous event stream (kiosk monitors, no login) |

These are registered via `cds.on('bootstrap')` (before CDS auth middleware) so they don't require authentication.

### Local Development

For local development with `cds watch`, CAP uses mock authentication:

```bash
cds watch  # → mock auth enabled, any user accepted
```

To test with real XSUAA tokens locally, use `cds bind`:

```bash
cds bind -2 xsuaa-imsdev  # Bind to real XSUAA instance
cds watch --profile hybrid # Use bound services
```

This issues real JWTs through the SAP IDP login flow, matching production behavior.

## Architecture Reference

### Identity Provider

The platform uses the **default SAP ID Service** (`accounts.sap.com`) as its Identity Provider. This is the shared SAP-managed IDP that supports SAP Universal ID — any user who has registered at account.sap.com can authenticate.

#### Why Default IDP (Not Custom IAS)

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

#### When to Reconsider

Switch to a custom IAS tenant if you later need:
- Corporate SSO federation (customer IDPs via SAML/OIDC)
- Named technical users with audit identity (beyond service keys)
- Certificate-based automation auth with rotation policies
- Social login (Google, GitHub, etc.)
- Fine-grained conditional access rules

---

### XSUAA Configuration

The XSUAA instance (`tutorials-xsuaa`) is configured via `xs-security.json`.

#### Scopes

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

#### Role Collections

| Role Collection | Includes | Assigned to |
|----------------|----------|-------------|
| Tutorials SuperAdmin | SuperAdmin + Admin + Display + Developer + Everyone | Platform operators |
| Tutorials Admin | Admin + Display + Developer + Everyone | Content administrators |
| Tutorials Developer | DeveloperApp + Everyone | Not needed for public access |
| Tutorials Display | Display + Everyone | Event monitor operators |

#### Important: Role Collections Are NOT Auto-Assigned

Users who log in via SAP ID Service do **not** automatically receive any role collection. Role collections must be manually assigned in BTP Cockpit (Security → Role Collections → assign user) or auto-assigned via Trust Configuration settings.

This is why public-facing services use `@requires: 'authenticated-user'` instead of scope-based authorization — see [Service Authorization](#service-authorization) below.

---

### Service Authorization

#### CAP `@requires` Annotations

| Service | Path | `@requires` | Access Level |
|---------|------|-------------|--------------|
| **DeveloperService** | `/api` | `'authenticated-user'` | Any logged-in user |
| **ScannerService** | `/scanner` | `'authenticated-user'` | Any logged-in user |
| **AdminService** | `/admin` | `'Admin'` | Scope-protected |
| **DisplayService** | `/display` | `'DisplayApp'` | Scope-protected |
| **ConsolidationService** | `/api/v1` | `'ConsolidationScope'` | Service-to-service |
| **SearchService** | `/search` | `'any'` | Fully public (no auth) |
| **EventStreamService** | `/event-stream` | `'any'` | Fully public (no auth) |

#### Understanding `@requires` Values

- **`'any'`** — No authentication required. Anyone can call the endpoint, even without a JWT. Use for truly public data (search, event streams, build catalog).
- **`'authenticated-user'`** — A valid JWT must be present, but no specific scope is needed. The user just needs to have logged in successfully. This is the standard pattern for public apps where any registered user should have access.
- **`'ScopeName'`** — The JWT must contain this specific scope, which requires the user to have a role collection assigned that includes a role template referencing that scope. Use for admin/operational endpoints.

#### Why DeveloperService Uses `authenticated-user`

The DeveloperService is the main public-facing API for tutorial progress tracking. It uses `'authenticated-user'` rather than the `'DeveloperApp'` scope because:

1. **Scalability** — millions of community users should be able to track progress without admin intervention
2. **No provisioning** — users don't need a role collection assigned in BTP Cockpit
3. **Identity is sufficient** — the JWT's `sub` claim provides the user identity needed for progress tracking; no elevated privilege is required to complete tutorial steps
4. **Graceful first-use** — the service handles unknown users by returning empty progress, allowing the frontend to show "log in to start tracking"

---

### Authentication Flows

#### Public Tutorial Browsing (Unauthenticated)

```
User → AppRouter → /content/tutorials/:slug → CAP content-store → HANA BLOB → HTML
User → /search → SearchService → results (no auth)
User → /build/catalog → catalog JSON (no auth)
```

No login required. Tutorial content, search, and catalog data are fully public.

#### Progress Tracking (Authenticated)

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

#### Admin Operations (Scope-Protected)

```
Admin navigates to /admin-ui/
  → AppRouter requires auth → login redirect
    → After login, JWT includes scopes IF role collection assigned
      → AdminService checks 'Admin' scope in JWT
        → Access granted or 403 Forbidden
```

Admins must have the "Tutorials Admin" or "Tutorials SuperAdmin" role collection manually assigned in BTP Cockpit.

---

### Automation & Service-to-Service Auth

#### Client Credentials (No IDP Involved)

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

#### Content Publishing

Content publishing uses a simpler bearer token mechanism:

```bash
# Set in CI secrets and on the deployed app
export CONTENT_API_KEY="<DEV-content-api-key — fetch from BTP credstore, do NOT commit>"

# The publish script includes this as Authorization: Bearer header
npm run publish-content
```

This is validated in `srv/lib/content-store.js` — not through XSUAA. It's a deliberate simplification for the build pipeline.

#### Adding `authorities` for Automation (If Needed)

To grant scopes to service keys via `client_credentials`, add to `xs-security.json`:

```json
"authorities": [
  "$XSAPPNAME.SuperAdmin",
  "$XSAPPNAME.ContentAuthor"
]
```

This is NOT currently configured. Add it only if automation scripts need XSUAA-scoped access beyond the `CONTENT_API_KEY` pattern.

---

### User Identity in CAP

#### How Users Are Identified

```js
// In any CAP service handler:
const user = req.user;         // CAP User object
const userId = req.user.id;    // JWT 'sub' claim (Universal ID unique identifier)
```

The `sub` claim from the JWT maps to `Users.uuid` in the database. This is stable across sessions and devices for the same Universal ID account.

#### First-Time User Handling

The DeveloperService handles unknown users gracefully:

```js
const dbUser = await SELECT.one.from(dbUsers).where({ uuid: user.id });
if (!dbUser) return { completedSteps: [], points: 0, badges: [] };
```

A User record is created lazily on first meaningful interaction (e.g., completing a step), not on first login.

---

### Security Boundaries Summary

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

### Data Privacy Integration (DPI) readiness

Issue [#960](https://github.com/sap-tutorials/tutorials-ims/issues/960) landed the `@PersonalData` annotation cleanups that make the schema ready for the SAP Data Privacy Integration (DPI) service, but the plugin adoption (`@cap-js/data-privacy`) is **deferred** to plugin 1.x GA due to an upstream bug in 0.6.2 (see the spec at `docs/superpowers/specs/2026-07-04-960-data-privacy-plugin-design.md`, "Scope revision" section).

**What is in place today**:

- 13 entities annotated with `@PersonalData.EntitySemantics` covering the full DataSubject / DataSubjectDetails / Other spectrum
- `cascade: 'delete'` on 7 user-owned detail entities (PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs, DeveloperEnvironmentLinks, CodeCheckSubmissions, ValidateAnswerSubmissions, AuthorAiRequests); driven by `srv/lib/anonymization-cascade.js`. Hybrid test coverage: `test/hybrid/anonymization-cascade-compositions.test.js`.
- `cascade: 'identity-replace'` on Users, `cascade: 'audit-only'` on TaskRecords, `cascade: 'null-personal'` on Advocates
- `DataSubjectRole: 'Developer'` on the three admin-authored audit entities (AnalyticsQueryHistory, AnalyticsSavedQuery, BranchDecisions) that stay `EntitySemantics: 'Other'`
- Concepts moved from `@PersonalData: {Other}` (which existed only to register with audit-logging) to `@cds.changelog` — the semantically correct home for admin merge/veto/rename curation trail

**What is NOT in place today** (planned for a follow-up issue):

- `/dpp/information` and `/dpp/retention` endpoints — require `@cap-js/data-privacy` install, which is blocked on plugin 1.x GA
- xs-security scopes `$XSAPPNAME.PersonalDataManagerUser` and `$XSAPPNAME.DataRetentionManagerUser` — pending plugin install
- Approuter routes for `/dpp/*` — pending plugin install
- Retention *windows* — those live in DPI's own admin UI (organizational attribute + condition set → rule). CDS annotations declare which entities carry personal data; DPI decides how long

**When plugin 1.x ships**, the follow-up issue can pick up cleanly: the annotations are already correct, and the ready blueprints for xs-security wiring, approuter routes, and smoke tests live in the original plan at `docs/superpowers/plans/2026-07-04-960-data-privacy-plugin.md` (Tasks 7, 8, 9).

---

### Future Considerations

#### If You Need Finer-Grained Control on DeveloperService

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

#### If You Migrate to IAS

1. Create IAS tenant and establish trust with BTP subaccount
2. Configure user federation (SAP ID Service can be an upstream IDP to IAS)
3. Update `oauth2-configuration.redirect-uris` in `xs-security.json`
4. No changes needed to CAP service code — `authenticated-user` works with any trusted IDP
