# IAS Tenant-Foundation Decision Doc — MCP OAuth Issuer (and, later, #2506 Branded Login)

**Date:** 2026-09-29
**Status:** Research / decision (read-only). No `cf`/`btp`/console mutation was performed producing this doc.
**Scope:** Whether/how to use SAP Cloud Identity Services (IAS) as the OAuth issuer for the tutorials-ims MCP endpoint, and the tenant-foundation constraints that also govern issue #2506 (branded login).
**Author of research:** Claude (Explore + doc fetch), citing SAP-docs `btp-cloud-identity-services` raw markdown and `cap.cloud.sap`.

> All quotes are verbatim from the cited SAP-docs `main`-branch markdown or CAP docs. Where a fact could only be confirmed by live console/CLI inspection, it is flagged **OPEN QUESTION** and routed to §D.

---

## Exec Summary

**BROKER-APP FINDING (2026-09-29, live + docs):** The CF `identity` service broker ALWAYS creates a **"Bundled / SAP BTP solution"** app — Application Type is fixed at creation and NO `-c` key overrides it (broker publishes an empty create schema; confirmed via `cf curl`). `public-client:true` + `authorization_code_pkce_s256` ARE honored at the OAuth layer, and a matching `redirect_uri` passes initial authorize validation (HTTP 200; a non-matching redirect 400s), BUT the interactive `/oauth2/authorize` still fails **"required parameters missing" after the login leg** on the bundled app. **Implication:** the broker `identity` instance is meant to be the CAP backend's *service credential* (X509_GENERATED), NOT the interactive public-client. An interactive public-PKCE client (mcp-remote/desktop) must be a **STANDALONE IAS app**, created via:
- **Official Terraform** `SAP/terraform-provider-sap-cloud-identity-services` → `sci_application` with `authentication_schema.oidc_config.restricted_grant_types=["authorizationCodePkceS256"]` (reproducible — the eventual wiring path), OR
- the IAS **admin console** (Applications → Create → OpenID Connect) / **SCIM Applications API** (fast for the POC).

Keep the broker instance only for the CAP backend's X509 service credential. **POC decision: create a throwaway standalone OIDC app in the console for the M1 measurement; adopt Terraform `sci_application` for reproducible wiring only after M1 is GREEN.**



**LIVE-VERIFIED (2026-09-29, read-only `btp`/`cf`):** Two of the three open questions are now closed with evidence:
- **Provisioning an IAS app is app-scoped — zero subaccount blast radius.** After `cf create-service identity application tutorials-identity-mcp`, `btp list security/trust` is UNCHANGED (still exactly 2 entries: `atxgsg7zi` + `sap.default`). Creating/binding an IAS app does NOT mutate the subaccount trust → **DEV testing cannot break PROD login via the trust layer.**
- **`tutorials-identity-mcp` is the ONLY `identity` service instance subaccount-wide.** No PROD app depends on an IAS *binding* today (PROD auth is still XSUAA). DEV can proceed in full isolation.
- **RESIDUAL (console-only):** whether other apps are registered directly on the `atxgsg7zi` tenant in the IAS console (bypassing CF). The earlier console screenshot showed 4 apps (SAP BTP subaccount Tutorial System, our POC app, Administration Console, User Profile) — consistent with a tutorial-system-scoped tenant, but confirm no PROD-critical bundled app lives there before any tenant-level change (which we are NOT doing for MCP anyway).

**Is DEV-isolated IAS testing safe from PROD? — YES, if and only if you stay strictly inside the app-scoped layer.**

The deciding facts:

1. **IAS applications are per-application registrations, edited one at a time.** Every SAP-docs configuration procedure begins with *"Choose the application that you want to edit"* and the save confirmation names the single app (*"Application &lt;name&gt; updated"*). Redirect URIs, subject-name-identifier, app type, and OIDC trust are all set on that one app. The only documented breakage warning — *"The application will stop working if the configuration of the application is not updated…"* — is scoped to *the application being edited*. ([configure-oidc…authorization-code-flow](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-openid-connect-oidc-application-for-authorization-code-flow-4a94254.md))

2. **The CAP `identity` service instance / binding is per-space and per-instance.** A `cds bind -2 <ias-instance>` binding records `"space": "dev"` and `"instance": "<name>"` and is *"specific to [your] dev space and should not be submitted or shared."* ([cap.cloud.sap/docs/node.js/authentication#ias](https://cap.cloud.sap/docs/node.js/authentication)). So DEV can bind its own `identity` instance and PROD a different one — fully isolated at the CF-space level, exactly like the existing per-space destination pattern already in `mta-mcp.yaml`.

3. **The dangerous surface is small and clearly signposted.** The genuinely tenant-wide, all-apps-affecting changes are: the tenant **custom domain** (Tenant Settings → Custom Domain — changes the host for *every* app and requires re-pointing every SP), tenant-default **risk-based authentication** (*"The rules apply to all applications in the tenant, including the `Administration Console`… changes apply immediately"* — can lock admins out), tenant-wide password/authentication policies, tenant user-attribute *directory* definitions, and the **subaccount default trust config** (`sap.default`). None of these is touched by creating or configuring one dedicated OIDC app.

**SAFE PATTERN (recommended and sufficient):** *One dedicated IAS OIDC application per CF space, mutate only that application, never touch the shared subaccount trust, the tenant custom domain, tenant-wide policies, or the `sap.default` config.* This lets you prove MCP-IAS auth entirely in the DEV space with **zero subaccount-level mutation**.

**Caveat (must be stated):** No SAP-docs page contains an explicit sentence "changes to one application do not affect other applications or production login." Independence is strongly *implied* by the uniform per-app editing model and the explicit tenant-vs-app split in [configuring-applications](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configuring-applications-61ad3b0.md), but it is not a documented guarantee — so the console read-only checks in §D are the confirming step before any PROD-adjacent action.

**On the shared tenant `atxgsg7zi`:** it is almost certainly **shared** (it is trusted at the subaccount level for "business users" and this subaccount hosts multiple DevRel tools). Using it for MCP via a *dedicated app* is safe; **renaming or re-domaining it is not** — those are tenant-wide. Recommendation: **use the shared tenant for the MCP app (dedicated app, no tenant mutation); do NOT rename/re-domain it. Reserve any custom-domain/branding decision for #2506 and evaluate a dedicated tenant there.**

---

## A. DEV/PROD Isolation (highest priority — the deciding constraint)

Context recap: IAS trust + tenant config are subaccount-level, but DEV and PROD are separate **CF spaces** in the one subaccount `tutorial-system` (3c6fa3f1-db8c-4e47-9048-fa8c84b867cb, eu10-005). Multiple DevRel tools share the subaccount.

### A1. Are IAS *applications* per-application and independent? — YES (risk: LOW)

**Evidence (verbatim):**
- Config is per-app: *"Choose the application that you want to edit."* → *"Choose the Trust tab."* → *"Under SINGLE SIGN-ON, choose OpenID Connect (OIDC) Configuration."* On save: *"the system displays the message **Application &lt;name of application&gt; updated**."* ([configure-oidc…authorization-code-flow](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-openid-connect-oidc-application-for-authorization-code-flow-4a94254.md))
- Redirect URIs are an app property: *"The redirection URIs to which the response can be sent. You can add up to 20 redirect URIs."* (same doc)
- App-level cert is decoupled from tenant: *"Your choice of Active certificate in the list is not related with the choice of Default certificate in Tenant Settings…"* (same doc)
- Tenant-vs-app split is explicit: the overview table separates settings *"On a tenant level"* from settings *"Specific for the application"*. ([configuring-applications](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configuring-applications-61ad3b0.md))
- Subject Name Identifier is per-app and can even differ from a parent: *"the configuration of the Subject Name Identifier of that child application can be different from the parent application…"* ([configure-the-subject-name-identifier…](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-the-subject-name-identifier-sent-to-the-application-1d020e3.md))

**Conclusion:** Creating/configuring the POC app `tutorials-mcp-desktop-client` (or a per-space equivalent) does not, per the documented model, affect other apps or PROD login. **Caveat:** no explicit isolation *guarantee* sentence exists (see Exec Summary). Confirm via §D read-only checks.

### A2. Is the `identity` service instance bound per-space? — YES (risk: LOW)

**Evidence (verbatim, CAP):** `cds bind -2 bookshop-ias` produces a binding recording `"space": "dev"`, `"instance": "bookshop-ias"`, `"kind": "ias-auth"`; the docs note the binding is *"specific to [your] dev space and should not be submitted or shared."* ([cap.cloud.sap/docs/node.js/authentication#ias](https://cap.cloud.sap/docs/node.js/authentication))

The `identity` instance is provisioned by `cf create-service identity application …` in a specific space (as the POC already did in DEV) and bound to the app in that space via the MTA `requires`/`resources` graph — identical isolation to the destination pattern already documented in `mta-mcp.yaml` (*"Destinations are subaccount-level, so DEV and PROD … need DISTINCT … names"*). DEV binds its own `identity` instance/app; PROD binds a different one. **Fully space-isolated.**

### A3. What IAS-level actions have subaccount-wide (PROD-affecting) blast radius?

See the **SAFE vs DANGEROUS** table below. Summary: **app-scoped (safe)** = create app, edit that app's redirect URIs / subject-name-identifier / type / display name / app-level trust & risk-based auth. **Tenant/subaccount-scoped (dangerous)** = custom domain, tenant-default risk-based auth, tenant password/authentication policies, tenant user-attribute *directory* schema, the subaccount `sap.default` trust config, and changing a *shared* app that PROD also uses.

### A4. The SAFE PATTERN — is "one dedicated IAS OIDC app per space, never mutate the shared trust or default" correct and sufficient? — YES (risk: LOW)

Correct and sufficient. Concretely, to set up + test MCP-IAS entirely in DEV without touching PROD auth:
1. Use a **dedicated** IAS OIDC application for the MCP client, distinct from anything PROD uses (the POC `tutorials-mcp-desktop-client` already exists in DEV, bound to nothing).
2. Provision/keep the `identity` service instance **in the DEV space** (already done via `cf create-service identity application`).
3. Bind it to a DEV-space CAP app and flip *that DEV deployment's* `srv-mcp` to `auth: ias` (or `ias-auth`) — see §C.
4. **Never** open Tenant Settings → Custom Domain / Risk-Based Authentication / password policies; **never** edit the subaccount `sap.default` trust; **never** edit a shared app.
5. Confirm no PROD app config changed via §D read-only checks.

The per-app editing model (A1) + per-space binding (A2) make this airtight *for the app layer*.

### A5. Does binding `identity` in DEV or flipping srv-mcp (DEV) to `auth.kind: ias` require any subaccount-level trust change? — Purely app+space scoped, with ONE precondition (risk: LOW, one **OPEN QUESTION**)

- **The precondition is already satisfied.** The subaccount must trust the IAS tenant for `identity`-service-issued tokens to be accepted. Established facts state `atxgsg7zi.accounts.ondemand.com` is **already an Active trust** at the subaccount level. So the trust exists; binding a new `identity` instance and flipping DEV `srv-mcp` to IAS consumes that existing trust and does **not** require creating or modifying it.
- **CAP migration aid reduces risk further:** *"To ease your migration from XSUAA-based to IAS-based authentication, the ias strategy automatically supports tokens issued by XSUAA when you provide the necessary credentials."* ([cap.cloud.sap/docs/node.js/authentication](https://cap.cloud.sap/docs/node.js/authentication)) — i.e. an `ias`-configured service can still accept the existing XSUAA tokens during transition.
- **OPEN QUESTION (console-only):** Whether creating a *new* `identity` service instance auto-registers/creates a *new* application object on the IAS tenant (the "application" plan does create an app registration), and whether that touches the subaccount trust list. The SAP-docs pages fetched (`configure-trust`, `add-client-credentials-for-microservices`, `integrating-with-existing-customer-landscape`) do **not** describe the BTP-subaccount↔IAS-tenant trust-establishment mechanics or whether an `identity` instance mutates it. → Confirm with §D checks D5/D6 (compare subaccount trust list and IAS app list before/after — read-only).

**Crux answer:** With the tenant trust already Active, DEV IAS wiring is provably app+space scoped and needs **no** subaccount-level *mutation*. The only residual is verifying (read-only) that spinning up the `identity` instance doesn't silently alter the shared trust — which the docs neither promise nor deny.

---

## B. Tenant Identity — Rename + Custom Domain

### B6. Can the tenant be renamed? What is `atxgsg7zi`? (risk of rename: N/A for ID; MEDIUM for relying on display name)

**Two distinct things:**
- **Tenant *display name* — EDITABLE.** *"The tenant display name. This information can be edited. If you have not specified a specific tenant name, you will see the tenant ID instead. You can change the name to make it more understandable for you."* Constraints: *"between 1 and 50 characters… upper case (A-Z)… lower case (a-z)… numbers 0-9, spaces, and the following symbols: _ - . '"*. ([change-a-tenant-s-display-name](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/change-a-tenant-s-display-name-a513c91.md))
- **Tenant *ID* / host `atxgsg7zi` — the identifier embedded in the host.** The host format is documented as *"`<tenant ID>.accounts.ondemand.com` or `<tenant ID>.accounts.cloud.sap`"* ([use-custom-domain…](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/use-custom-domain-in-identity-authentication-c4db840.md)). So `atxgsg7zi` **is the tenant ID** in `atxgsg7zi.accounts.ondemand.com`.

**Mutable in place:** display name only. **Fixed at provisioning:** the tenant ID / default host — **OPEN QUESTION** on strict immutability: no fetched SAP-docs page states the tenant ID/host *cannot* be changed. It is strongly implied (the display name merely overlays the ID; the sanctioned way to get a different *user-facing* URL is a custom domain, not editing the ID), but there is no verbatim immutability sentence. Provisioning is via SAP, not self-service (see B-note below). **Practical takeaway:** treat the host `atxgsg7zi.accounts.ondemand.com` as fixed; do not build anything on the assumption the ID string can change; changing the user-facing login URL = custom domain (B7), not a rename.

**Provisioning note:** *"Identity Authentication provides one productive tenant per customer…"*; tenants are *"purchased"* then *"provisioned"*, requested via SAP KBAs/notes (2751968, 2717185). ([request-create-and-delete…tenant](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Monitoring-and-Reporting/request-create-and-delete-identity-authentication-tenant-b442658.md)) → A *dedicated* tenant for tutorials is a support-ticket, licensing-gated action, not a click.

### B7. Custom login domain — supported, but tenant-wide (risk: HIGH if applied to shared tenant)

**Supported:** *"Identity Authentication allows you to use a custom domain that is different from the default ones (`<tenant ID>.accounts.ondemand.com` or `<tenant ID>.accounts.cloud.sap`) - for example `www.mytenant.com`."*

**Requirements (verbatim):**
1. Role: *"You are assigned the Manage Tenant Configuration role."*
2. *"You must have a custom domain."* (*"Internationalized domain names (IDNs) are not supported."*)
3. *"You must have configured the CNAME DNS record on your domain to point to the host name used to access Identity Authentication."* (region-specific target host).
4. SSL certificate: *"SSL certificate signed by the trusted CA"* via CSR; algorithms *"SHA-256, SHA-384 and SHA-512."*
5. SAP incident may be needed: *"If you already have a trusted CA added… report a new incident on SAP Support Portal… with component `BC-IAM-IDS`."*

All from [use-custom-domain-in-identity-authentication](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/use-custom-domain-in-identity-authentication-c4db840.md).

**Scope = tenant-wide (blast radius).** Configured under **Tenant Settings → Custom Domain**, i.e. applies to the whole tenant / all apps. And it forces SP-side reconfiguration: *"after you select the custom host… make sure that you also change the name of the identity provider on the service provider side… If you have set trusts with more than one service provider… change the name in every provider, otherwise the trusts will not work."* → On a **shared** tenant, enabling a custom domain would require re-pointing **every** relying party, including anything PROD uses. **This is a subaccount/tenant-blast-radius change and must not be done as part of MCP DEV testing.**

### B8. Is `atxgsg7zi` shared or dedicated to tutorials? — Almost certainly SHARED (risk: HIGH for any tenant-wide change)

Established facts: it is trusted at the subaccount level as an origin for "business users", and the subaccount `tutorial-system` hosts multiple DevRel tools. That strongly indicates a **shared** tenant (the DevRel/DevX corporate IAS tenant), not one dedicated to tutorials. **This is not fully provable from docs** → **OPEN QUESTION**, resolved by §D checks (list applications on the tenant; if apps for other tools/products exist, it is shared). If shared, renaming (display name) is cosmetic-but-confusing for other teams, and re-domaining has cross-team blast radius.

### B9. Should MCP use the shared tenant or a dedicated tenant? (recommendation + tradeoffs)

**Recommendation: use the SHARED tenant `atxgsg7zi` for the MCP OIDC app (dedicated app, no tenant mutation).** For the *MCP issuer* use case this is the lowest-risk, fastest path — the trust already exists, and everything MCP needs lives in the app-scoped layer.

| | Shared tenant `atxgsg7zi` (dedicated app) | Dedicated tutorials tenant |
|---|---|---|
| Setup effort | Low — trust already Active; just add an app | High — SAP ticket, licensing (`one productive tenant per customer` may block a 2nd productive), new subaccount trust |
| MCP-issuer risk | LOW (app-scoped only) | LOW but slow |
| Custom domain / branding (#2506) | HIGH blast radius (affects all apps) | Clean — own domain, no neighbors |
| Isolation from other DevRel tools | Shared user base & tenant policies | Full isolation |
| Governance | Must coordinate any tenant-wide change | Independent |

**Split decision:** MCP issuer → shared tenant + dedicated app. **Branded login (#2506)** → the custom-domain/branding requirement is where a dedicated tenant earns its keep; decide that in #2506's own foundation review, not here. Do **not** couple MCP to a tenant rename/re-domain.

---

## C. Sequencing

### C10. Tenant-foundation decisions to LOCK before wiring MCP

Everything downstream keys off tenant identity + the app registration. Lock these first; changing them later forces rework:

| Decision to lock | Why it must precede wiring | What breaks if changed later |
|---|---|---|
| **Which tenant** (shared `atxgsg7zi` vs dedicated) | Determines the discovery issuer / OIDC host `https://<tenant>.accounts.ondemand.com` | `srv-mcp` issuer validation config, `mcp-remote` discovery URL, every client re-registration |
| **Custom domain? (yes/no + which)** | Changes the issuer host & authorize/token endpoints tenant-wide | All redirect URIs, discovery issuer, cached client configs — full re-issue; SP re-point on shared tenant |
| **The dedicated MCP app's client_id** | Emitted in tokens; `srv-mcp` validates audience/issuer | Re-registering the client everywhere; desktop clients re-onboard |
| **Redirect URIs for the MCP client** | PKCE authorization_code flow needs them pre-registered (up to 20) | Broken authorize flow (this is likely the current POC "required parameters missing" area — handled elsewhere) |
| **subject-name-identifier** (POC currently `personnelNumber`) | Becomes the `sub` in the OIDC token → user identity key in HANA progress data | Identity-key mismatch / orphaned progress rows if changed post-launch |
| **`srv-mcp` auth strategy** (`xsuaa` → `ias`/`ias-auth`, per space) | Determines which issuer is trusted | Token rejection; but CAP `ias` auto-accepts XSUAA tokens, easing the flip |

**Do not lock in this doc; these are decisions for Tom + maintainer.** The point is the *ordering*: tenant + domain + client identity must be settled before `srv-mcp` issuer config and redirect URIs are finalized.

### C11. How do MCP-IAS and #2506 (branded login) relate at the tenant level?

- **Shared foundation:** both ultimately authenticate against the same IAS tenant, and both care about the *issuer host*. If #2506 introduces a **custom domain**, the issuer host changes tenant-wide → MCP's discovery issuer and redirect URIs would need updating too. So they are **coupled through the custom-domain decision**.
- **Independent otherwise:** MCP needs only an app-scoped OIDC registration (no branding, no default-trust change). #2506 branded login likely needs **tenant-wide** changes (custom domain per B7, and possibly the subaccount **default trust** / branding style). Those are the dangerous surface MCP deliberately avoids.
- **Recommended relationship:** treat MCP-IAS as the **app-scoped, low-risk first mover** that proves the plumbing without any tenant mutation. Treat #2506 as a **separate, tenant-wide** change with its own blast-radius review. If #2506 lands a custom domain, schedule an MCP issuer-config update as an explicit dependent follow-up. **Do not sequence MCP behind #2506, and do not let #2506's tenant-wide changes ride in on MCP's PR.**

---

## SAFE vs DANGEROUS Actions (app-scoped vs subaccount/tenant-scoped)

| Action | Scope | Blast radius | Verdict | Evidence |
|---|---|---|---|---|
| Create a new OIDC application | App | That app only | **SAFE** | [create-a-new-application](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/create-a-new-application-0d4b255.md) |
| Edit a *dedicated* app's redirect URIs | App | That app only | **SAFE** | [oidc auth-code flow](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-openid-connect-oidc-application-for-authorization-code-flow-4a94254.md) |
| Set a *dedicated* app's subject-name-identifier | App | That app only (can differ from parent) | **SAFE** | [subject-name-identifier](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-the-subject-name-identifier-sent-to-the-application-1d020e3.md) |
| Set app type / display name | App | That app only | **SAFE** | [app type](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-an-application-s-type-6fee9c3.md), [app display name](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/change-an-application-s-display-name-83d65d0.md) |
| Choose default IdP *for an application* | App | That app only | **SAFE** | [choose-default-idp-for-an-application](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/choose-default-identity-provider-for-an-application-e9d8274.md) |
| Risk-based auth *for an application* | App | That app only (overrides tenant default for that app) | **SAFE** (except if you pick the Administration Console app) | [risk-based per app](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-risk-based-authentication-for-an-application-bc52fbf.md) |
| App-level attribute mapping (Trust → Attributes) | App | That app's tokens only | **SAFE** | [attrs from directory](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configuring-user-attributes-from-the-identity-directory-d361407.md) |
| Create/bind `identity` instance in DEV space | CF space | DEV space app only | **SAFE** (per-space binding) | [cap authentication#ias](https://cap.cloud.sap/docs/node.js/authentication) |
| Flip DEV `srv-mcp` to `auth: ias` | CF space (DEV) | DEV deploy only; consumes existing Active trust | **SAFE** | [mta-mcp.yaml], [cap ias auto-accepts XSUAA](https://cap.cloud.sap/docs/node.js/authentication) |
| **Tenant custom domain** (Tenant Settings → Custom Domain) | **Tenant** | **ALL apps; forces SP re-point on every trust** | **DANGEROUS** | [use-custom-domain](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/use-custom-domain-in-identity-authentication-c4db840.md) |
| **Tenant-default risk-based auth** (Tenant Settings) | **Tenant** | **ALL apps incl. Administration Console; applies immediately; can lock admins out** | **DANGEROUS** | [default risk-based for all apps](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-default-risk-based-authentication-for-all-applications-in-the-tenant-1aab51a.md) |
| Tenant password / authentication policies | **Tenant** | ALL apps' login | **DANGEROUS** | [configuring-tenant-settings](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configuring-tenant-settings-d4d6fdc.md) |
| Tenant user-attribute *directory* schema | **Tenant** | Attribute uniqueness/availability for all apps | **DANGEROUS** | [subject-name-identifier note re tenant-scoped attrs](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/configure-the-subject-name-identifier-sent-to-the-application-1d020e3.md) |
| Change the **subaccount default trust** (`sap.default`) | **Subaccount** | ALL apps in subaccount, incl. PROD | **DANGEROUS** | established fact (btp trust list) + §A5 OPEN QUESTION |
| Edit a **SHARED** app (one PROD also uses) | App, but shared | Every consumer of that app, incl. PROD | **DANGEROUS** | inferred from per-app model — MCP must use a *dedicated* app |
| Tenant **display-name** rename | Tenant (cosmetic) | Cosmetic label; confusing for co-tenants but not a login break | **CAUTION** (shared tenant) | [change-a-tenant-s-display-name](https://raw.githubusercontent.com/SAP-docs/btp-cloud-identity-services/main/docs/Operation-Guide/change-a-tenant-s-display-name-a513c91.md) |

**Reliable UI tell (from research):** settings reached via the **Tenant Settings** tile = tenant-wide (dangerous); settings reached via the **Applications** tile → pick an application = app-scoped (safe).

---

## Tenant-Identity Findings (rename / custom-domain feasibility + blast radius)

- **Rename:** only the **display name** is editable (1–50 chars). The **tenant ID/host `atxgsg7zi`** is the fixed identifier in `atxgsg7zi.accounts.ondemand.com`; treat as immutable (strict immutability = **OPEN QUESTION**, not documented). A new/dedicated tenant is an SAP-support/licensing action (`one productive tenant per customer`).
- **Custom domain:** supported but **tenant-wide**; needs Manage Tenant Configuration role + owned domain + CNAME + CA-signed SSL cert (+ possible `BC-IAM-IDS` incident); **forces re-pointing every service-provider trust** on the tenant. On a shared tenant this hits PROD and every DevRel tool → HIGH blast radius, out of scope for MCP.
- **Shared vs dedicated:** `atxgsg7zi` is almost certainly the shared DevRel corporate tenant (OPEN QUESTION → §D). Use it for MCP via a dedicated app; do not rename/re-domain it for MCP.

---

## Locked-Before-Wiring Checklist

Settle these (Tom + maintainer) before finalizing `srv-mcp` IAS config or registering redirect URIs:

- [ ] **Tenant choice:** shared `atxgsg7zi` (recommended for MCP) vs dedicated tutorials tenant.
- [ ] **Custom domain: NO for MCP** (defer to #2506); confirm MCP will use the default `atxgsg7zi.accounts.ondemand.com` issuer host.
- [ ] **Dedicated MCP OIDC app** identified/created per space (DEV app exists: `tutorials-mcp-desktop-client`); PROD gets its own.
- [ ] **client_id(s)** captured for `srv-mcp` issuer/audience validation, per space.
- [ ] **Redirect URIs** enumerated + registered on the dedicated app (PKCE authorize flow).
- [ ] **subject-name-identifier** confirmed (`personnelNumber` in POC) — locks the `sub`→HANA-user key; changing later orphans progress rows.
- [ ] **`srv-mcp` auth strategy** flip plan per space (`xsuaa` → `ias`/`ias-auth`), relying on CAP's XSUAA-token auto-acceptance during transition.
- [ ] **Confirm (read-only, §D) the existing `atxgsg7zi` subaccount trust is Active and untouched** before/after DEV wiring.
- [ ] **Governance note:** no Tenant Settings tile changes as part of MCP work.

---

## D. Console + CLI Read-Only Verification Steps (for Tom)

All read-only. Run in the IAS Administration Console (`https://atxgsg7zi.accounts.ondemand.com/admin`) and via `btp`/`cf` CLI. **Change nothing.**

**D1. What applications exist on the tenant (is it shared?)**
IAS Admin Console → **Applications & Resources → Applications**. Scan the list. If you see apps for other DevRel tools/products (not just tutorials), the tenant is **shared** (confirms B8). Note which look PROD-critical.

**D2. What the tutorials MCP POC app looks like**
Applications → open `tutorials-mcp-desktop-client` → **Trust tab → OpenID Connect Configuration**. Read (don't edit): client ID, registered redirect URIs, app type (public/PKCE), and **Subject Name Identifier** (expect `personnelNumber`). This is the app-scoped surface you'll wire.

**D3. What PROD currently depends on for auth**
- `cf target` (confirm space), then in DEV vs PROD spaces: `cf services` and, for the PROD approuter/srv, `cf env <prod-app>` — inspect `VCAP_SERVICES` for `xsuaa` vs `identity` bindings (redacted creds OK). Confirms PROD is still XSUAA-only and which instances it binds. (Use the read-only `cf_env`/`cf_services` MCP tools.)
- Cross-check the MCP `mta-mcp.yaml`: PROD currently binds `tutorials-xsuaa` (existing service) — verify no `identity` binding leaked into PROD.

**D4. Tenant identity — display name vs host, custom domain present?**
IAS Admin Console → **Tenant Settings**. Read the **display name** and confirm the host is `atxgsg7zi.accounts.ondemand.com`. Open **Custom Domain** (read-only) — confirm **none is configured** (blank). If a custom domain *is* already set tenant-wide, that changes the issuer host for everyone and must feed into C10/C11.

**D5. Subaccount trust list (baseline before any DEV wiring)**
`btp list security/trust --subaccount 3c6fa3f1-db8c-4e47-9048-fa8c84b867cb` — capture the current Active trusts (`sap.default` + `atxgsg7zi.accounts.ondemand.com`). This is your before-snapshot for A5.

**D6. Confirm creating/binding the DEV `identity` instance did NOT alter the trust or PROD apps (after any DEV change)**
Re-run D5 and D1 and diff against the baseline: the subaccount trust list should be unchanged, and no PROD app config should differ. (Read-only diff — resolves the A5/A1 OPEN QUESTIONs empirically.)

**D7. Roles you'd need for any tenant-wide change (to confirm you are NOT about to trip one)**
In the Admin Console, tenant-wide screens require **Manage Tenant Configuration**; app screens require **Manage Applications**. If your MCP work only ever uses the **Applications** tile, you never enter the tenant-wide surface. (Awareness check, not an action.)

---

## Open Questions (require console/live inspection — none block DEV testing)

1. **A1/A5:** No SAP-docs page contains an explicit "one app's config cannot affect another app or PROD login" guarantee, nor whether provisioning a new `identity` instance mutates the subaccount trust. → Resolve empirically via D5/D6 before/after diff.
2. **B6:** Strict immutability of the tenant ID/host `atxgsg7zi` is implied, not documented. → Treat as fixed; a dedicated tenant is an SAP-support action.
3. **B8:** Whether `atxgsg7zi` is shared vs tutorials-dedicated is inferred (strongly) from the subaccount-level "business users" trust + multi-tool subaccount. → Confirm via D1.
4. **Custom-domain regional target host** and whether a `BC-IAM-IDS` incident is required for tutorials' CA are #2506 concerns, not MCP's.

---

## Sources

SAP-docs `btp-cloud-identity-services` (branch `main`), raw:
- Operation-Guide/configuring-applications-61ad3b0.md
- Operation-Guide/create-a-new-application-0d4b255.md
- Operation-Guide/configuring-openid-connect-oidc-a789c9c.md
- Operation-Guide/configure-openid-connect-oidc-application-8a0aa2e.md
- Operation-Guide/configure-openid-connect-oidc-application-for-authorization-code-flow-4a94254.md
- Operation-Guide/configure-an-application-s-type-6fee9c3.md
- Operation-Guide/change-an-application-s-display-name-83d65d0.md
- Operation-Guide/configure-the-subject-name-identifier-sent-to-the-application-1d020e3.md
- Operation-Guide/choose-a-corporate-identity-provider-as-default-44dd636.md
- Operation-Guide/choose-default-identity-provider-for-an-application-e9d8274.md
- Operation-Guide/configure-default-risk-based-authentication-for-all-applications-in-the-tenant-1aab51a.md
- Operation-Guide/configure-risk-based-authentication-for-an-application-bc52fbf.md
- Operation-Guide/configuring-user-attributes-from-the-identity-directory-d361407.md
- Operation-Guide/configuring-user-attributes-from-a-corporate-identity-provider-621017f.md
- Operation-Guide/configure-trust-f96e4c5.md
- Operation-Guide/configure-different-trust-configurations-for-the-same-identity-authentication-tenant-ba2faa9.md
- Operation-Guide/configuring-tenant-settings-d4d6fdc.md
- Operation-Guide/change-a-tenant-s-display-name-a513c91.md
- Operation-Guide/change-tenant-texts-via-administration-console-c24b1d0.md
- Operation-Guide/use-custom-domain-in-identity-authentication-c4db840.md
- Monitoring-and-Reporting/request-create-and-delete-identity-authentication-tenant-b442658.md
- Monitoring-and-Reporting/custom-domains-7cb2ea5.md (troubleshooting only)

CAP docs:
- cap.cloud.sap/docs/node.js/authentication (IAS-based Authentication `#ias`; `ias-auth` binding; XSUAA-token auto-acceptance)

Local project evidence (read-only):
- srv-mcp/package.json (current `auth.kind: xsuaa`)
- mta-mcp.yaml (per-space destination pattern; adopts existing `tutorials-xsuaa`; PKCE is client-side against the confidential client)
