# Authentication Primer

How user identity flows from browser to database in the tutorials platform, covering XSUAA configuration, JWT token structure, user resolution, and the differences between the Java IMS and CAP implementations.

## Token Flow

```
Browser → AppRouter → XSUAA (SAP IDP) → JWT issued
  → AppRouter forwards request + JWT to CAP srv
    → CAP extracts user identity from JWT
      → Service handler resolves DB user from identity
```

The AppRouter handles the OAuth2 login flow via XSUAA. Once authenticated, every request to the backend carries a Bearer JWT issued by XSUAA. The backend never handles login directly — it only validates and reads the token.

## XSUAA Configuration

Both systems bind to the **same XSUAA service instance** (`xsuaa-imsdev` / `xsuaa-imsqa` / `xsuaa-imsprod`). The `xs-security.json` in this repo is reference documentation only — deployment uses `org.cloudfoundry.existing-service` to bind the pre-existing instance.

### Scopes

| Scope | Purpose | Consumers |
|-------|---------|-----------|
| `Admin` | Full admin access (CRUD, GDPR, notifications) | Internal team |
| `ContentAuthor` | Create/edit content | Tutorial authors |
| `DeveloperApp` | Tutorial progress, step completion | End users (developers.sap.com) |
| `MobileApp` | Mobile app features | SAP Events mobile app |
| `DisplayApp` | Read-only UI access (leaderboards) | Event display monitors |
| `ConsolidationScope` | Account merge operations | SCI technical user only |
| `Everyone` | Baseline access | All authenticated users |

### Role Templates

Roles bundle scopes. Assignment happens in BTP cockpit via role collections:

- **Admin** = `Admin` + `Everyone`
- **ContentAuthor** = `ContentAuthor` + `DisplayApp` + `Everyone`
- **DeveloperApp** = `DeveloperApp` + `Everyone`
- **MobileApp** = `MobileApp` + `DisplayApp` + `Everyone`
- **DisplayApp** = `DisplayApp` + `Everyone`
- **ConsolidationScope** = `ConsolidationScope` (no `Everyone` — technical user)

## JWT Token Structure

The XSUAA JWT contains these identity-relevant claims:

```json
{
  "user_uuid": "a1b2c3d4-...",      // SAP IDP Global User ID (stable across systems)
  "email": "user@example.com",
  "given_name": "Alice",
  "family_name": "Developer",
  "user_name": "alice@example.com",  // Login name (usually email)
  "scope": ["tutorials-poc.DeveloperApp", "tutorials-poc.Everyone"],
  "xs.user.attributes": {
    "email": ["user@example.com"],
    "given_name": ["Alice"],
    "family_name": ["Developer"]
  }
}
```

The **`user_uuid`** claim is the primary identity key. It is the SAP IDP "Global User ID" — stable, unique, and consistent across all BTP services for the same person. This is what both systems use to identify users in the database.

## User Resolution: Java IMS

The Java IMS uses a multi-layer identity chain:

### 1. AuditUserFilter (Servlet Filter)

Runs on **every** request before controllers execute:

```java
// AuditUserFilter.java
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
if (auth instanceof JwtAuthenticationToken token) {
    Jwt jwt = token.getToken();
    userUuid = jwt.getClaimAsString("user_uuid");  // ← primary identity
}
```

### 2. Technical User Mapping

Before resolving the user in the database, the filter checks `AppTechUsers` — a configured mapping of technical service account IDs to real user identifiers:

```java
Map<String, String> techUsers = appTechUsers.getTechUsersMapping();
if (techUsers.containsKey(userUuid)) {
    userUuid = techUsers.get(userUuid);  // remap technical → real account
}
```

This handles cases where a technical service (like the SCI consolidation user or the AEM proxy) calls the API on behalf of a real user. The token identifies the technical account, but the mapping redirects to the actual user.

### 3. User Resolution + Auto-Creation

```java
// UserResolverHelperImpl.java
User user = userRepository.findOneBySapId(accountNumber);
if (user == null) {
    User newUser = new User(BasicUUIDGenerator.generate(), accountNumber);
    user = userRepository.save(newUser);
}
```

If the user doesn't exist in the database, they're created on first access with their `user_uuid` as the `sapId` field.

### 4. SCI Enrichment (Optional)

For display purposes (leaderboards, export), the Java app calls the **SCI** (SAP Cloud Identity) service to fetch rich user profiles:

```java
sciClient.getUser(accountNumber);  // Returns displayName, email, etc.
```

This is a network call to the BTP Identity Directory via the Destination service. It provides richer profile data than what's in the JWT.

### 5. Thread-Local Context

The resolved user's internal DB ID is stored in a thread-local for downstream access:

```java
AuditUserContext.setUserId(resolved.get().getId().toString());
```

This means any code in the request chain can access the current user without re-resolving.

## User Resolution: CAP Node.js

CAP handles most of this automatically via its XSUAA integration:

### 1. Automatic JWT Processing

CAP's `@sap/cds` framework automatically validates the JWT and populates `req.user`:

```javascript
const user = req.user;
// user.id    → "user_uuid" claim (the SAP IDP Global User ID)
// user.attr  → { email, given_name, family_name, ... } from xs.user.attributes
// user.is('Admin') → scope check
```

No filter needed — CAP does this for every authenticated request.

### 2. Database User Lookup + Auto-Creation

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

### 3. Authorization

CDS annotations enforce scope requirements at the service level:

```cds
service DeveloperService @(requires: 'DeveloperApp') { ... }
service AdminService @(requires: 'Admin') { ... }
service DisplayService @(requires: 'DisplayApp') { ... }
```

CAP rejects requests without the required scope before the handler runs.

## Key Differences

| Aspect | Java IMS | CAP Node.js |
|--------|----------|-------------|
| JWT extraction | Manual (`AuditUserFilter`) | Automatic (`req.user`) |
| Identity claim | `user_uuid` from JWT | `req.user.id` (same claim) |
| Technical user mapping | `AppTechUsers` config bean | `TECH_USERS` env var + middleware |
| User auto-creation | Every request (filter) | Lazy (in handler) |
| Profile enrichment | SCI network call | JWT attributes (no call) |
| Authorization | Spring Security + annotations | CDS `@requires` |
| Request context | Thread-local (`AuditUserContext`) | `req.user` per-request |

## Technical User Authentication (Basic Auth Bypass)

Technical service accounts authenticate via HTTP Basic Auth instead of XSUAA JWTs. This handles CI/CD pipelines, the SCI consolidation service, and other machine-to-machine callers that cannot perform an OAuth2 login flow.

### Java IMS Implementation

`AppTechUsers` is a Spring `@ConfigurationProperties` bean with two maps:

1. **`app.tech-users`** (username → password) — Credentials for Basic Auth. The `BasicAuthBypassFilter` validates incoming Basic Auth headers against this map. Valid credentials grant `SCOPE_Admin` authority without needing a JWT.

2. **`app.tech-users-mapping`** (tech_id → real_uuid) — Identity remapping. After Basic Auth succeeds, the `AuditUserFilter` checks if the authenticated identity should be remapped to a different real user for audit/context purposes.

Values are configured via Cloud Foundry environment variables (not committed to source).

### CAP Implementation

The middleware at [srv/lib/tech-user-auth.js](srv/lib/tech-user-auth.js) runs before CAP's auth middleware (registered via `cds.on('bootstrap')`). It:

1. Checks for `Authorization: Basic ...` header
2. Validates credentials against `TECH_USERS` environment variable
3. Optionally remaps identity via `TECH_USERS_MAPPING` environment variable
4. Sets `req.user` as a `cds.User` with configured roles — CAP then uses this for `@requires` checks

If no Basic Auth header is present, or credentials don't match, the middleware passes through to CAP's standard JWT authentication.

### Configuration

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

### Deployment

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

### How It Differs From Java

| Aspect | Java (`AppTechUsers`) | CAP (`tech-user-auth.js`) |
|--------|----------------------|--------------------------|
| Config source | Spring `application.yaml` properties | Environment variables |
| Auth grant | Always `SCOPE_Admin` | Configurable roles per user |
| Identity mapping | Separate `techUsersMapping` map | Separate `TECH_USERS_MAPPING` env var |
| Middleware position | `BasicAuthBypassFilter` (before Spring Security) | `app.use()` on bootstrap (before CDS auth) |
| Fallthrough | Falls through to JWT auth if no match | Same — passes to CAP JWT if no match |

## Database Schema (Identity Fields)

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

## Public Access + Lazy Login (AppRouter)

Tutorial pages are publicly readable without authentication. Login is triggered on demand when a user wants interactive features (progress tracking, step completion).

### Route Architecture

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

### Login Flow

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

### Frontend Auth Detection

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

### Key Design Points

- **Static content is fully public** — no redirect to login, no flash of login page
- **API routes require auth** — the AppRouter enforces XSUAA session before proxying to CAP
- **Login is explicit** — only triggered by user action (clicking profile icon)
- **SSO is transparent** — if the user is already authenticated with SAP IDP (e.g., from another SAP site), the OAuth flow resolves immediately without showing a login form
- **Session cookie** — after login, the AppRouter session cookie persists until the user logs out or the session expires. Subsequent page navigations retain the authenticated state.

## Unauthenticated Endpoints

Two endpoints bypass XSUAA entirely:

| Endpoint | Why Unauthenticated |
|----------|---------------------|
| `GET /build/catalog` | Called by CI/CD pipeline at build time (no user context) |
| `WS /display/websocket` | STOMP broker for event monitors (display screens, no login) |

These are registered via `cds.on('bootstrap')` (before CDS auth middleware) so they don't require authentication.

## Local Development

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
