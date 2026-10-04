# Clean Logout via IAS-fronted Approuter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approuter 23.x native OIDC `end_session` fire against IAS (`atxgsg7zi`) on `/logout`, so the IAS session is terminated and the next person on a shared machine is not silently re-SSO'd.

**Architecture:** Bind a new dedicated IAS `identity` instance to the single `tutorials-approuter` module alongside the existing XSUAA binding; flip protected routes to `authenticationType: ias` (XSUAA kept for authz via `xsuaa-cross-consumption`); the pre-existing `logout` endpoint then performs RP-initiated logout. The dual-IdP picker is preserved via `sap_idp` + `dynamicIdentityProvider`.

**Tech Stack:** SAP BTP Cloud Foundry, `@sap/approuter` 23.3.0, MTA (`mbt`), SAP IAS (identity service, `application` plan), XSUAA, Hugo (signin page), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-03-clean-logout-ias-fronting-design.md`

## Global Constraints

- IAS tenant is **`atxgsg7zi`** only. Never reference `alzmza7li` (abandoned attempt).
- The existing `tutorials-identity` instance is **NOT touched** — it is the public-PKCE client for `mcp-remote` (`client_id 0b1e8b56-…`). Breaking it is a hard failure.
- No change to login UX: both picker buttons (`sap.default`, `sap.custom`) keep working.
- No forced authentication (Force Authentication must stay OFF).
- IAS logout endpoint (verified): `https://atxgsg7zi.accounts.ondemand.com/oauth2/logout`.
- All DEV work only; PROD cutover is gated and out of scope for this plan's code tasks.
- DEV and PROD **share the subaccount** — anything surfacing on PROD needs a planned window.
- PRs target **DEV**; `main` is protected. Deploy from fresh `origin/DEV`, never a feature branch. Run `cf target` before any push.
- Approuter deploy is bundle-gated: admin-UI/static changes need a FULL `mbt build` (no `--skip-build`, no `-m` scoping).
- Wrap any command with >~50 lines output (`mbt build`, `cf deploy`, `npm run build:all`) in `scripts/quiet-run.sh`.

---

## Risk-first sequencing

Tasks 1–3 prove the three assumptions that can only be settled empirically on DEV, **before** the irreversible-feeling full route flip. If Task 1 (identity continuity) fails, STOP — the plan needs a reconciliation layer added before proceeding. Tasks 4–7 are the implementation. Task 8 is PROD-readiness docs. Each task is independently testable.

---

### Task 1: Provision the IAS instance + prove identity continuity (DEV probe)

This is the hard gate. It creates the new IAS instance and answers "does an IAS-fronted login resolve to the same user key XSUAA produces today?" using a single bound test, without touching the main approuter yet.

**Files:**
- Create: `scripts/spikes/ias-identity-continuity.cjs` (throwaway probe harness; delete after)
- Reference: `.deploy/xs-security.json` (redirect-uri origins to mirror)

**Interfaces:**
- Produces: a DEV IAS instance named `tutorials-approuter-identity` (confidential/X509 posture) that later tasks adopt as `existing-service`.
- Produces: a documented finding — IAS `sub`/`user_uuid` of a real test user vs. that user's existing XSUAA-resolved key in `Users.sapId`.

- [ ] **Step 1: Write the instance config file**

Create `scripts/spikes/approuter-identity-params.json`:

```json
{
  "oauth2-configuration": {
    "redirect-uris": ["https://*.cfapps.eu10-005.hana.ondemand.com/login/callback?authType=ias"],
    "post-logout-redirect-uris": ["https://*.cfapps.eu10-005.hana.ondemand.com/**"]
  },
  "xsuaa-cross-consumption": true
}
```

- [ ] **Step 2: Create the IAS instance out-of-band on DEV**

Run (confirm `cf target` = `tutorial-system/dev` first):

```bash
cf target | grep -i space   # MUST show: space: dev
cf create-service identity application tutorials-approuter-identity -c scripts/spikes/approuter-identity-params.json
cf service tutorials-approuter-identity   # wait for: create succeeded
```

Expected: instance `create succeeded`. (Entitlement is proven — `tutorials-identity` already exists.)

- [ ] **Step 3: Create an X509 service key and inspect the client posture**

```bash
cf create-service-key tutorials-approuter-identity ar-key -c '{"credential-type":"X509_GENERATED"}'
cf service-key tutorials-approuter-identity ar-key
```

Expected: credentials include `clientid` (a NEW client_id, distinct from `0b1e8b56-…`), `certificate`/`key`, `authorization_endpoint` and `end_session_endpoint` on `atxgsg7zi.accounts.ondemand.com`. Confirms a confidential X509 client minted on the correct tenant.

- [ ] **Step 4: Document the identity-continuity finding**

Capture one real test user's current XSUAA-resolved key (from the live DEV `/auth/user` while logged in today, or a `Users` row) and compare to the IAS `sub` that an IAS login for the same user would carry. If an interactive IAS login through the approuter isn't wired yet, record the IAS `sub` from a direct IAS token for that user (the MCP flow already proves IAS token issuance on this tenant) and compare UUIDs.

Write the finding into the spec's "Identity-continuity gate" section as GATE PASS or GATE FAIL with the two UUIDs (redact to first 8 chars).

- [ ] **Step 5: Decision checkpoint — STOP if gate fails**

If the IAS `sub` ≠ the XSUAA-resolved user key, STOP and report: the plan needs a UUID→user reconciliation task inserted before Task 4. Do not proceed to route flips. If PASS, continue.

- [ ] **Step 6: Commit the probe + finding**

```bash
git add scripts/spikes/ docs/superpowers/specs/2026-10-03-clean-logout-ias-fronting-design.md
git commit -m "spike(auth): provision IAS approuter instance + identity-continuity finding (#2610)"
```

---

### Task 2: Confirm the `sap_idp` IAS mapping that preserves both picker buttons (DEV probe)

Resolves the spec open item: which `sap_idp` values route correctly to each IdP once IAS fronts the approuter. Probe-only; no committed route flip yet.

**Files:**
- Reference: `hugo/layouts/signin.html:12` (`/login?sap_idp=sap.default`), `:15` (`/login?sap_idp=sap.custom`)

**Interfaces:**
- Produces: the confirmed `sap_idp` string for each button under IAS fronting (e.g. plain `sap.default` / `sap.custom`, or an IAS chain like `sap.custom,<ias-idp-key>`), consumed by Task 6.

- [ ] **Step 1: Enumerate the IAS trust/IdP keys available on the subaccount**

```bash
cf curl "/v3/service_instances?names=tutorials-approuter-identity" >/dev/null  # sanity
# Inspect subaccount trust configs (IdP origin keys) via BTP:
btp list security/trust --subaccount <tutorial-system-dev-guid>
```

Expected: the origin keys backing `sap.default` and `sap.custom`. Record them.

- [ ] **Step 2: Document the mapping**

Record in the spec's "Open items" → resolved: the exact `sap_idp` value each button must send so SAP Universal ID and social both resolve under IAS fronting. No code change in this task.

- [ ] **Step 3: Commit the finding**

```bash
git add docs/superpowers/specs/2026-10-03-clean-logout-ias-fronting-design.md
git commit -m "spike(auth): confirm sap_idp mapping for dual-IdP picker under IAS (#2610)"
```

---

### Task 3: Align approuter version on the branch

Ensures the branch declares the 23.x approuter that supports native `end_session`, matching DEV runtime.

**Files:**
- Modify: `approuter/package.json` (`@sap/approuter` dependency)

- [ ] **Step 1: Update the dependency**

In `approuter/package.json`, change `"@sap/approuter": "^16.0.0"` to `"@sap/approuter": "^23.3.0"`.

- [ ] **Step 2: Verify it matches DEV**

```bash
jq -r '.dependencies["@sap/approuter"]' approuter/package.json   # expect ^23.3.0
MSYS_NO_PATHCONV=1 git show origin/DEV:approuter/package.json | jq -r '.dependencies["@sap/approuter"]'  # expect ^23.3.0
```

Expected: both print `^23.3.0`.

- [ ] **Step 3: Commit**

```bash
git add approuter/package.json
git commit -m "chore(approuter): declare @sap/approuter ^23.3.0 (#2610)"
```

---

### Task 4: Bind the IAS instance to the approuter module

Adds the second auth binding and replaces the stale 16.x "one binding only" comment. This is the structural MTA change.

**Files:**
- Modify: `.deploy/mta.yaml:361-371` (approuter `requires` + stale comment)
- Add: an `identity` resource (existing-service) in the `resources:` section (~line 447+)

**Interfaces:**
- Consumes: the `tutorials-approuter-identity` instance from Task 1.
- Produces: approuter module bound to XSUAA + IAS.

- [ ] **Step 1: Replace the stale comment and add the IAS require**

In `.deploy/mta.yaml`, the approuter `requires:` currently reads (line 361 + comment 362-371):

```yaml
    requires:
      - name: tutorials-xsuaa
      # NOTE: the approuter is deliberately bound to ONLY the confidential
      # tutorials-xsuaa (its login client). ...
      # ... Keeping one binding avoids that.
      # approuter resolves runtime secrets from the credstore via
      # approuter/lib/credstore-secret.js (same binding the srv uses). The retired
      # /admin/rebuild handler (#1659 C.4) no longer reads from it.
      - name: tutorials-credstore
```

Replace the `tutorials-xsuaa` line + the stale NOTE (362-368) with:

```yaml
    requires:
      - name: tutorials-xsuaa
      # Dual auth binding (approuter 23.x). XSUAA is kept for authorization/scopes;
      # tutorials-approuter-identity (IAS) fronts interactive login so native
      # OIDC end_session fires on /logout (#2610, clean logout on shared machines).
      # The 16.x "one binding only / non-deterministic 500s" constraint no longer
      # applies: 23.x supports XSUAA+IAS together. Routes set authenticationType:ias
      # EXPLICITLY (xs-app.json) to avoid the per-request BTP-security-endpoint probe.
      # NOTE: tutorials-identity (the PUBLIC mcp-remote PKCE client) is a SEPARATE
      # instance and is intentionally NOT bound here.
      - name: tutorials-approuter-identity
      # approuter resolves runtime secrets from the credstore via
      # approuter/lib/credstore-secret.js.
      - name: tutorials-credstore
```

- [ ] **Step 2: Add the existing-service resource**

In the `resources:` section (near the `tutorials-xsuaa` resource), add:

```yaml
  # IAS instance fronting approuter interactive login so native end_session fires
  # on /logout (#2610). Created out-of-band (like tutorials-identity) for a stable
  # client_id; adopted here. NOT the mcp-remote public client (that is tutorials-identity).
  - name: tutorials-approuter-identity
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: tutorials-approuter-identity
```

- [ ] **Step 3: Validate MTA descriptor parses**

```bash
scripts/quiet-run.sh mbt build -p=. -t=./.mta-check --mtar=/dev/null 2>&1 | tail -5 || true
# Lighter check if mbt is heavy: yq validates YAML structure
yq '.resources[] | select(.name == "tutorials-approuter-identity")' .deploy/mta.yaml
yq '.modules[] | select(.type=="approuter.nodejs") | .requires[].name' .deploy/mta.yaml | grep tutorials-approuter-identity
```

Expected: the resource prints; the require name prints — confirming wiring.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "feat(approuter): bind IAS identity instance for clean logout (#2610)"
```

---

### Task 5: Flip protected routes to `authenticationType: ias`

Changes the ~40 `xsuaa` routes to `ias`. `none` routes (public + MCP) stay untouched.

**Files:**
- Modify: `approuter/xs-app.json` (routes with `"authenticationType": "xsuaa"`)

- [ ] **Step 1: Flip xsuaa → ias on all protected routes**

Replace every route-level `"authenticationType": "xsuaa"` with `"authenticationType": "ias"`. Do NOT touch any `"authenticationType": "none"` route (public content, `/mcp-auth/*`, `/content/*`, build feeds, `/signin`, `/version`, etc.).

```bash
# Count before (expect ~40):
grep -c '"authenticationType": "xsuaa"' approuter/xs-app.json
sd -F '"authenticationType": "xsuaa"' '"authenticationType": "ias"' approuter/xs-app.json
# Count after (expect 0 xsuaa, same count now ias):
grep -c '"authenticationType": "xsuaa"' approuter/xs-app.json   # expect 0
```

- [ ] **Step 2: Verify no `none` route was altered + JSON is valid**

```bash
jq '.routes | map(select(.authenticationType=="none")) | length' approuter/xs-app.json  # unchanged vs origin/DEV
jq -e . approuter/xs-app.json >/dev/null && echo "valid JSON"
MSYS_NO_PATHCONV=1 git show origin/DEV:approuter/xs-app.json | jq '.routes | map(select(.authenticationType=="none")) | length'  # compare equal
```

Expected: `none` count equal to DEV baseline; JSON valid.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): route authenticationType xsuaa -> ias (#2610)"
```

---

### Task 6: Preserve the dual-IdP picker + wire back-channel logout

Applies the Task 2 `sap_idp` mapping, enables `dynamicIdentityProvider` on `/login`, and adds `backChannelLogoutEndpoint`.

**Files:**
- Modify: `approuter/xs-app.json` (the `^/login(\?.*)?$` route; the `logout` object)
- Modify: `hugo/layouts/signin.html:12,15` (only if Task 2 found the button values must change)

**Interfaces:**
- Consumes: the confirmed `sap_idp` values from Task 2.

- [ ] **Step 1: Enable dynamicIdentityProvider on the /login route**

In `approuter/xs-app.json`, on the route `"source": "^/login(\\?.*)?$"`, add `"dynamicIdentityProvider": true` (keep its existing `authenticationType` — it should now be `ias` from Task 5). This makes the approuter honor the `sap_idp` query param under IAS.

- [ ] **Step 2: Add backChannelLogoutEndpoint to the logout object**

Change the `logout` object from:

```json
"logout": { "logoutEndpoint": "/logout", "logoutPage": "/" }
```

to:

```json
"logout": { "logoutEndpoint": "/logout", "logoutPage": "/", "backChannelLogoutEndpoint": "/backchannel-logout" }
```

- [ ] **Step 3: Apply the Task 2 sap_idp mapping to the picker (only if required)**

If Task 2 found the button `sap_idp` values must change for IAS, update `hugo/layouts/signin.html:12` and `:15` accordingly. If Task 2 confirmed plain `sap.default`/`sap.custom` still resolve, make NO change and note that here.

- [ ] **Step 4: Validate**

```bash
jq -e '.routes[] | select(.source=="^/login(\\?.*)?$") | .dynamicIdentityProvider' approuter/xs-app.json  # expect true
jq -e '.logout.backChannelLogoutEndpoint' approuter/xs-app.json  # expect "/backchannel-logout"
```

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json hugo/layouts/signin.html
git commit -m "feat(approuter): preserve dual-IdP picker + back-channel logout under IAS (#2610)"
```

---

### Task 7: Deploy to DEV and verify clean logout end-to-end

The real-thing test: deploy, confirm login both ways, confirm logout clears the IAS session, confirm MCP intact.

**Files:**
- Modify: `test/e2e/signin.spec.ts` (add logout-clears-session assertion)

- [ ] **Step 1: Deploy to DEV from this branch's build**

Per the repo deploy convention (full build, no `--skip-build`, no `-m`):

```bash
cf target   # MUST be tutorial-system/dev
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
scripts/quiet-run.sh npm run build:all
cd .deploy && scripts/quiet-run.sh mbt build && scripts/quiet-run.sh cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Expected: deploy succeeds; approuter now bound to XSUAA + IAS (`cf env tutorials-approuter | grep -o '"identity"'`).

- [ ] **Step 2: Verify login via BOTH picker buttons**

Browser: open DEV `/signin`, click "SAP Universal Account" → authenticates → lands authenticated. Repeat with "Other Options" (social). Both must succeed.

- [ ] **Step 3: Verify logout clears the IAS session (the core assertion)**

Log in as user A. Click logout (`/logout`). With a network trace open, confirm the chain reaches `https://atxgsg7zi.accounts.ondemand.com/oauth2/logout`. Then navigate back to a protected route — confirm a **fresh login prompt** appears (NOT a silent re-SSO as A). This is the bug being fixed.

- [ ] **Step 4: Verify MCP public-PKCE flow intact**

Run the `mcp-remote` DEV connection (per `docs/end-users/mcp-quickstart.md`, DEV `client_id 0b1e8b56-…`). Confirm it still obtains a token against the untouched `tutorials-identity`.

- [ ] **Step 5: Add the e2e assertion**

In `test/e2e/signin.spec.ts`, add a test that logs in, hits `/logout`, and asserts the next protected-route visit renders the login/signin page (not authenticated content). Follow the file's existing pattern (self-skips without `SMOKE_BASE_URL`).

- [ ] **Step 6: Run e2e against DEV**

```bash
export SMOKE_BASE_URL="https://<dev-approuter-route>"
scripts/quiet-run.sh npm run test:e2e
```

Expected: the new logout-clears-session test passes.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/signin.spec.ts
git commit -m "test(e2e): assert logout clears IAS session (#2610)"
```

---

### Task 8: PROD-readiness documentation

Captures the gated PROD cutover steps so the handoff is actionable. No PROD change executed here.

**Files:**
- Modify: `docs/developers/architecture/authentication.md` (document the IAS-fronted logout flow)
- Modify: the spec's Rollout section (mark DEV steps done; leave PROD steps as the gated checklist)

- [ ] **Step 1: Document the new auth/logout flow**

Add a section to `docs/developers/architecture/authentication.md` describing: approuter bound to XSUAA + IAS, routes `authenticationType: ias`, `/logout` → IAS `end_session`, dual-IdP picker via `sap_idp`, and the two separate IAS instances (approuter vs mcp-remote).

- [ ] **Step 2: Record the PROD cutover checklist**

In the spec, mark the DEV rollout steps complete and leave the PROD steps as a checklist: add prod host (`developers.sap.com/**`) to the IAS instance `redirect-uris`/`post-logout-redirect-uris`; create the prod `tutorials-approuter-identity`; land the approuter 23.x bump on `main`; plan the shared-subaccount window; cutover only after identity-continuity PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/authentication.md docs/superpowers/specs/2026-10-03-clean-logout-ias-fronting-design.md
git commit -m "docs(auth): document IAS-fronted clean logout + PROD cutover checklist (#2610)"
```

---

## Self-review

**Spec coverage:** core mechanism (T4-5), identity instance strategy/two instances (T1,T4), route flip + explicit ias (T5), dual-IdP picker (T2,T6), logout wiring + back-channel (T6), identity-continuity gate (T1), approuter version (T3), testing incl. MCP-intact + e2e (T7), rollout + PROD caveat (T8). All spec sections map to a task.

**Placeholder scan:** no TBD/TODO; the only conditional step (T6 Step 3) is explicitly gated on a documented Task 2 output, with the "make no change and note it" branch spelled out.

**Type/name consistency:** instance name `tutorials-approuter-identity` used identically in T1/T4; `logoutEndpoint: /logout` and `backChannelLogoutEndpoint: /backchannel-logout` consistent; `sap_idp` values flow T2→T6.
