# IAS Setup Guide — BTP Subaccount Authentication Options

This guide covers authentication configuration for the CAP tutorials platform on a BTP subaccount. It presents two approaches — **Option A** (simple, recommended) and **Option B** (IAS-managed) — and explains when each is appropriate.

---

## Architecture Options

### Option A: Default SAP ID Service Trust (Recommended for Dev/POC)

```
BTP Subaccount → trusts → SAP ID Service (default, automatic)
  → User authenticates at accounts.sap.com (existing browser session = transparent SSO)
  → XSUAA issues JWT with sub from SAP ID Service
```

**Pros:** Zero configuration, transparent SSO for anyone with an SAP account, no IAS tenant needed.
**Cons:** No centralized identity management, no conditional auth, no social logins.

### Option B: IAS as Trust Point (Production with Corporate IDP)

```
BTP Subaccount → trusts → IAS (custom trust)
  → IAS authenticates user directly (SAP Universal ID = same credentials)
  → OR IAS delegates to a Corporate IDP you control (Azure AD, Okta, ADFS)
  → XSUAA issues JWT with sub from IAS
```

**Pros:** Centralized identity, MFA, conditional auth, social logins, corporate IDP delegation.
**Cons:** Requires IAS tenant configuration, identity federation setup for user data migration.

> **Important:** IAS does NOT proxy to SAP ID Service (accounts.sap.com) as a SAML 2.0 corporate IDP. SAP ID Service does not accept arbitrary SP registrations, so the SAML handshake fails. Users authenticate directly against IAS using the same SAP Universal ID credentials — the user store is shared within the global account.

---

## Option A: Default SAP ID Service (Quick Setup)

This is the simplest path. Every new BTP subaccount has SAP ID Service configured as the default trust automatically.

### Verify Trust Configuration

1. **BTP Cockpit** → Navigate to your subaccount
2. **Security** → **Trust Configuration**
3. Confirm **SAP ID Service** (Default identity provider) shows **Available for User Logon: Yes**

That's it. Users accessing your application are redirected to accounts.sap.com. If they have an active browser session (most SAP developers do), authentication is transparent — no login form.

### Deploy and Test

1. Deploy the MTA (see `CLAUDE.md` for deploy commands)
2. Access the approuter URL — you should be silently authenticated
3. If prompted, log in with your SAP account — subsequent visits will be transparent

### Assign Role Collections

1. **BTP Cockpit** → Subaccount → **Security** → **Role Collections**
2. Assign "Tutorials Admin" (or other role collections from xs-security.json) to your user
3. Use the user's email or SAP ID as the identifier

---

## Option B: IAS as Trust Point (Full Setup)

Use this when you need centralized identity management, corporate IDP delegation, conditional authentication, MFA enforcement, or social logins.

### Prerequisites

- BTP Global Account with entitlement to SAP Cloud Identity Services
- Admin access to IAS admin console
- Understanding that users authenticate **directly** against IAS (not proxied through SAP ID Service)

### Step 1: Obtain Your IAS Tenant

Most BTP global accounts include one IAS tenant at no additional cost.

1. **BTP Cockpit** → Global Account → **Security** → **Trust Configuration**
2. Check if an IAS tenant is already listed under "Custom Identity Provider for Applications"
3. If not, go to **Entitlements** → search for "Cloud Identity Services" → add to a subaccount
4. Create a service instance of plan `default` or `additional_tenant`
5. Note the IAS admin console URL: `https://<tenant-id>.accounts.ondemand.com/admin`

> **Note:** A single IAS tenant can serve multiple subaccounts.

### Step 2: Establish Trust from Subaccount to IAS

1. **BTP Cockpit** → Navigate to your subaccount
2. **Security** → **Trust Configuration**
3. Click **Establish Trust**
4. Select your IAS tenant from the dropdown (auto-discovered within the global account)
5. Leave defaults:
   - **Name**: Auto-populated
   - **Available for User Logon**: Yes
6. Click **Save**

At this point, both SAP ID Service (default) and IAS (custom) are active. Users will see an IDP picker.

### Step 3: Decide on IDP Availability

| Goal | Configuration |
|------|--------------|
| IAS only (no picker) | Set Default SAP ID Service → "Available for User Logon: No" |
| Both active (picker shown) | Leave both enabled |
| Default SAP ID + IAS as backup | Keep default as primary, IAS as option |

**Recommendation for production:** Set SAP ID Service to "Not Available for User Logon" so users go directly to IAS without a picker. But only do this after verifying login works through IAS (Step 5).

### Step 4: Configure Corporate IDP in IAS (If Applicable)

> **This step is only for corporate IDPs you control** (Azure AD, Okta, ADFS, PingFederate). Do NOT use this for SAP ID Service — it won't work.

If your users authenticate via a corporate IDP:

1. **IAS Admin Console** → **Identity Providers** → **Corporate Identity Providers**
2. Click **Create**
3. Enter a display name (e.g., "Company Azure AD")
4. Select type: **SAML 2.0 Compliant** or **OpenID Connect**
5. Upload/enter the corporate IDP's metadata
6. **On the corporate IDP side:** Register your IAS tenant as a trusted SP/relying party
   - IAS SP metadata: `https://<tenant-id>.accounts.ondemand.com/saml2/metadata`
7. Configure Identity Federation:
   - Set to "Use Identity Provider user store" if you want pass-through identity
   - Set to "Use Identity Authentication user store" for email-based matching

**Why SAP ID Service doesn't work here:** The "SAML 2.0 Compliant" type requires you to register IAS as a service provider on the remote IDP. SAP ID Service (accounts.sap.com) is a public IDP that does not accept SP registrations from arbitrary tenants. The SAML AuthnRequest from IAS gets rejected.

### Step 5: Verify Login Through IAS

1. Access your application URL
2. You should be redirected to your IAS tenant's login page
3. Log in with your SAP Universal ID credentials (same email/password as accounts.sap.com)
4. Verify you reach the application successfully

> **SAP Universal ID and IAS:** Within the same global account, the IAS user directory includes all users who have SAP Universal ID accounts. The same credentials work — this is not "proxying" to SAP ID Service; it's the same underlying identity directory.

### Step 6: Configure Subject Name Identifier (For User Data Migration)

If migrating user data from a system that used SAP ID Service directly, ensure the `sub` claim matches:

1. **IAS Admin Console** → **Applications & Resources** → **Applications**
2. Select the application representing your BTP subaccount (auto-registered by Step 2)
3. Go to **Trust** → **Subject Name Identifier**
4. Configure:
   - **Source**: Identity Directory
   - **Primary Attribute**: User UUID (or Login Name, depending on what the legacy system used)

**Why this matters:**

| Setting | `sub` claim | Impact |
|---------|-------------|--------|
| User UUID | IAS-generated UUID | May differ from SAP ID Service `sub` |
| Login Name | User's email/login | Matches if legacy used email as `sub` |

The CAP platform uses `Users.uuid = JWT sub` for lookups. Test with a known user before migrating data.

### Step 7: Verify Identity Continuity

```bash
# Decode the JWT from a login through IAS, then check:
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  cds.connect.to('db').then(async db => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const user = await SELECT.one.from(Users).where({ uuid: '<sub-from-jwt>' });
    console.log(user ? 'MATCH: ' + user.email : 'NO MATCH - check Subject Name Identifier config');
    process.exit(0);
  });
"
```

### Step 8: Social / Corporate Identity Providers (the live production setup)

> **This is the configuration that ships today** (DEV + PROD, `GITHUB_OIDC_ENABLED: "true"` in `deploy/dev.mtaext` / `deploy/prod.mtaext`). The themed `/signin` page (`hugo/layouts/signin.html`) presents five sign-in buttons:
>
> | Button | `sap_idp` routing | IAS registration |
> |--------|-------------------|------------------|
> | **Continue with SAP ID** | `sap.default` | None — direct XSUAA trust to SAP ID Service |
> | **Continue with GitHub** | `sap.custom,GitHub` | OIDC-Compliant Corporate IdP, backed by **our GitHub-OIDC shim** |
> | **Continue with Google** | `sap.custom,Google` | OIDC-Compliant Corporate IdP (Google is OIDC-native) |
> | **Continue with LinkedIn** | `sap.custom,LinkedIn` | OIDC-Compliant Corporate IdP (LinkedIn is OIDC-native) |
> | **Continue with Hugging Face** | `sap.custom,Hugging Face` | OIDC-Compliant Corporate IdP (Hugging Face is OIDC-native) |
>
> **Not "Social IdPs" in IAS.** Despite the user-facing framing, none of these are configured under IAS's **Social Identity Providers** screen. All four non-SAP providers are registered as **Corporate Identity Providers → OpenID Connect Compliant**. This is deliberate: the chain-form `sap_idp=sap.custom,<Name>` deep-link (see [authentication.md](../architecture/authentication.md#idp-pinning-via-sap_idp)) routes XSUAA through the `sap.custom` IAS trust and then has IAS apply `idp=<Name>` to pick the specific provider — a mechanism that only works for Corporate IdPs that carry a stable trust **Name**.
>
> **The IdP trust Name is load-bearing.** The `<Name>` in each button's `sap_idp=sap.custom,<Name>` **must exactly match** the Corporate Identity Provider **Display Name** you set in IAS (`GitHub`, `Google`, `LinkedIn`, `Hugging Face`). Rename a provider in IAS and the matching `/signin` button breaks (falls through to the default IdP). If you change a Name, update `hugo/layouts/signin.html` in lockstep.

#### Step 8a — Google (OIDC-native, simplest)

1. **Google Cloud Console** → create OAuth 2.0 credentials (Web application)
   - Authorized redirect URI: `https://<tenant-id>.accounts.ondemand.com/oauth2/callback`
2. **IAS Admin Console** → **Identity Providers** → **Corporate Identity Providers** → **Create**
   - **Display Name**: `Google` *(must match the `/signin` button's `sap_idp=sap.custom,Google`)*
   - **Type**: **OpenID Connect Compliant**
3. **OpenID Connect Configuration**:
   - **Discovery URL**: `https://accounts.google.com/.well-known/openid-configuration`
   - **Client ID** / **Client Secret**: from step 1
   - **Scopes**: `openid profile email`
4. **Identity Federation** → "Use Identity Authentication user store" (email-based matching, so social users merge onto their existing SAP-ID row by email — see [identity continuity](#step-7-verify-identity-continuity)).
5. Save, then **Enable** the IdP for the tutorials application under **Applications & Resources → Applications → `<your app>` → Identity Provider**.

#### Step 8b — LinkedIn and Hugging Face (OIDC-native, same recipe as Google)

Both expose a standard OIDC discovery document, so they follow the Google recipe exactly — only the provider-side app registration and discovery URL differ:

| Provider | Register app at | Discovery URL | IAS Display Name |
|----------|-----------------|---------------|------------------|
| LinkedIn | [LinkedIn Developers](https://www.linkedin.com/developers/apps) → "Sign In with LinkedIn using OpenID Connect" product | `https://www.linkedin.com/oauth/.well-known/openid-configuration` | `LinkedIn` |
| Hugging Face | [HF OAuth app settings](https://huggingface.co/settings/applications) | `https://huggingface.co/.well-known/openid-configuration` | `Hugging Face` |

For each: redirect URI = `https://<tenant-id>.accounts.ondemand.com/oauth2/callback`, scopes `openid profile email`, Type = **OpenID Connect Compliant**, and the **Display Name must match the `/signin` button Name exactly** (note the space in `Hugging Face`).

> **Apple is intentionally omitted** — "Sign in with Apple" requires a paid Apple Developer account. If you add it later, register it as another OIDC Corporate IdP and add a matching button to `signin.html`.

#### Step 8c — GitHub (needs the GitHub-OIDC shim)

GitHub is **OAuth 2.0 only** — it has no OIDC discovery document, no `id_token`, and no JWKS endpoint, so IAS cannot federate it as an OpenID Connect Corporate IdP directly. We bridge the gap with a small OIDC-compliant shim that runs **in the approuter** (`approuter/lib/github-oidc-shim.js`), wrapping GitHub's OAuth2 so IAS sees a normal OIDC provider.

The shim mounts at `/github-oidc/*` on the approuter and exposes the full OIDC surface IAS needs:

| Endpoint | Purpose |
|----------|---------|
| `GET /github-oidc/.well-known/openid-configuration` | OIDC discovery document |
| `GET /github-oidc/authorize` | Validates the IAS request, 302 → GitHub |
| `GET /github-oidc/callback` | Exchanges the GitHub code, fetches the profile, 302 → IAS |
| `POST /github-oidc/token` | Verifies PKCE, mints the RS256 `id_token` |
| `GET /github-oidc/jwks` | Public key for IAS to verify the `id_token` |

**Flag:** the shim is gated by `GITHUB_OIDC_ENABLED` (approuter env, read at call time). Currently `"true"` on both DEV and PROD. Off ⇒ the handler is a no-op pass-through (GitHub button then falls through to the default IdP).

**Prerequisites — five credstore secrets** (BTP Credential Store, resolved via `approuter/lib/credstore-secret.js`; never in `.mtaext` or source). Rotate via `/admin-ui/#secrets`:

| Alias | What it is |
|-------|-----------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | The GitHub **OAuth app** credentials (the shim is GitHub's client) |
| `GITHUB_OIDC_IAS_CLIENT_ID` / `GITHUB_OIDC_IAS_CLIENT_SECRET` | The client credentials **IAS** uses to call the shim's `/token` back-channel (IAS is the shim's client) |
| `GITHUB_OIDC_SIGNING_KEY` | RSA private key (PKCS#8 PEM) the shim signs `id_token`s with; the public JWK is derived from it on demand |
| `GITHUB_OIDC_STATE_SECRET` | Any sufficiently-random string; seals the stateless authorize→token correlation (A256GCM) |

**GitHub side** — create an OAuth app at [GitHub Developer Settings](https://github.com/settings/developers):
- **Authorization callback URL**: `https://<approuter-host>/github-oidc/callback`
- Copy the Client ID/Secret into the `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` credstore aliases.

**IAS admin steps** — register the shim as a Corporate IdP:

1. **IAS Admin Console** → **Identity Providers** → **Corporate Identity Providers** → **Create**
   - **Display Name**: `GitHub` *(must match `sap_idp=sap.custom,GitHub`)*
   - **Type**: **OpenID Connect Compliant**
2. **OpenID Connect Configuration**:
   - **Discovery URL**: `https://<approuter-host>/github-oidc/.well-known/openid-configuration` — IAS reads the shim's discovery, authorize, token, and JWKS endpoints from here automatically.
   - **Client ID**: the value you put in `GITHUB_OIDC_IAS_CLIENT_ID`
   - **Client Secret**: the value you put in `GITHUB_OIDC_IAS_CLIENT_SECRET`
   - **Scopes**: `openid profile email`
   - **PKCE**: S256 (the shim requires it)
3. **Identity Federation** → "Use Identity Authentication user store" (email-based matching). **Caveat:** GitHub emails are advisory — the shim keys identity on the **GitHub numeric user id** (OIDC `sub`), never on email, because `/user.email` is frequently null and noreply synthetics are not unique. A GitHub user whose verified primary email is private, or whose SAP-ID row has no email yet, will land on a **separate** `Users` row until an explicit account merge (the known #2552 boundary — see [authentication.md](../architecture/authentication.md#known-boundary-social-login-without-sap-id-account)).
4. Save, then **Enable** `GitHub` for the tutorials application (same place as Step 8a #5).

**Verify the shim is reachable before registering in IAS:**

```bash
# Discovery doc should return JSON with issuer = https://<approuter-host>
curl -s https://<approuter-host>/github-oidc/.well-known/openid-configuration | jq .issuer
# JWKS should return one RS256 key
curl -s https://<approuter-host>/github-oidc/jwks | jq '.keys[0].kty, .keys[0].alg'
```

If either returns a 503 `server_error`, a credstore secret is missing (`GITHUB_OIDC_SIGNING_KEY` for jwks, `GITHUB_CLIENT_ID` for authorize). If they 404, `GITHUB_OIDC_ENABLED` is not `"true"` on the approuter.

---

## Troubleshooting

### Users See IDP Picker

**Cause:** Both SAP ID Service and IAS trust are set to "Available for User Logon".
**Fix:** Disable one — set "Available for User Logon: No" for the one you don't want.

### IAS Login Fails with "Identity Provider could not process the authentication request"

**Cause:** IAS is configured to delegate to a "SAML 2.0 Compliant" corporate IDP that doesn't recognize IAS as a trusted SP (e.g., SAP ID Service / accounts.sap.com).
**Fix:** Remove the corporate IDP configuration. Users should authenticate directly against IAS with their SAP Universal ID credentials. If you need corporate IDP delegation, use an IDP you control (Azure AD, Okta) and register IAS as a trusted SP on that IDP's side.

### Transparent SSO Not Working (Login Form Appears)

**Cause:** Unlike SAP ID Service which many developers have persistent sessions for, IAS may not have an active session in the browser.
**Fix:** This is expected behavior with IAS. After first login, IAS maintains its own session. For truly transparent SSO, either:
- Use Option A (SAP ID Service default trust) — most SAP developers have active sessions
- Configure SSO session duration in IAS → Application → Authentication → Session Management

### User Gets New Identity (Progress Data Mismatch)

**Cause:** Subject Name Identifier in IAS doesn't match what the legacy system produced.
**Fix:** Update IAS application config (Step 6). The `sub` claim format depends on the source system.

### Application Returns 401

**Fix:** Verify:
1. XSUAA service instance exists and is bound to the app
2. At least one trust is established and active
3. `xs-security.json` redirect URIs match: `https://*.cfapps.*.hana.ondemand.com/**`
4. Role collections are assigned to the user

---

## Rollback

- **From Option B back to Option A:** Re-enable SAP ID Service default trust ("Available for User Logon: Yes"). Instant fix, no restart needed.
- **From Option A to Option B:** Establish IAS trust (Step 2), then optionally disable default trust (Step 3).

---

## References

- [SAP Help: Establish Trust with SAP Cloud Identity Services](https://help.sap.com/docs/btp/sap-business-technology-platform/establish-trust-and-federation-between-uaa-and-identity-authentication)
- [SAP Help: Configure Corporate Identity Provider in IAS](https://help.sap.com/docs/identity-authentication/identity-authentication/configure-corporate-identity-providers)
- [SAP Help: Social Identity Providers in IAS](https://help.sap.com/docs/identity-authentication/identity-authentication/configure-social-identity-providers)
- [SAP Help: Subject Name Identifier Configuration](https://help.sap.com/docs/identity-authentication/identity-authentication/configure-subject-name-identifier)
- [BTP Best Practice: Identity and Access Management](https://help.sap.com/docs/btp/best-practices/identity-and-access-management)
