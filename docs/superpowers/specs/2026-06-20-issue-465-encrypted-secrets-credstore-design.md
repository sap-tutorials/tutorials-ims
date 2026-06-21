# Phase 2-C: Encrypted secrets store via BTP Credential Store — design

**Issue:** [#465](https://github.com/sap-tutorials/tutorials-ims/issues/465) — final phase of the runtime-config research from [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444).

**Date:** 2026-06-20

**Research-design parent:** [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md)

**Sibling specs (already shipped):**

- Phase 2-A foundation + KG: `2026-06-20-issue-463-runtime-config-foundation-design.md` — PR #471
- Phase 2-B Secrets metadata-only: `2026-06-20-issue-464-secrets-visibility-design.md` — PR #482
- Phase 3 long-tail env-var migration: `2026-06-20-issue-466-long-tail-env-migration-design.md` — PR #491

## TL;DR

Add encrypted-value storage to the existing `Secrets` HANA entity (#482 metadata-only) via **BTP Credential Store**. The HANA entity stays metadata-only forever — values live in BTP Credential Store, keyed by `Secrets.key` as the credstore alias. Admin tile gains 4 OData operations (Set / Rotate / Clear / Reveal) with a 30-second auto-hide reveal window. CAP audit-logging captures all value reads/writes.

This PR completes the original #444 vision: every credential the platform uses has a single discoverable inventory + a managed value-storage path.

## Prerequisites resolved

| Prerequisite | Resolution |
| --- | --- |
| Encryption-key management decision (was Option A/B/C) | **Option B — BTP Credential Store, per-secret entries.** Option A (HANA SBSS) eliminated after Tom confirmed it's deprecated (`@sap/sbss` pinned to Node ≤22; SAP officially recommends migrating to BTP Credential Store for new cloud-native BTP apps). Option C (CF env wrapping key) considered but Option B is SAP-officially-recommended path, ships less code (no app-side crypto), and matches existing service-binding patterns. |
| Subaccount entitlement | **Confirmed available** in `tutorial-system` subaccount (Tom verified 2026-06-20). |
| Security review | **Scope reduced** to "review the spec doc against SAP's BTP Credential Store security guarantees" (no custom crypto to audit). Can run in parallel with brainstorming/spec-writing rather than blocking. |

## Implementation choices made during brainstorming

| Decision | Choice |
| --- | --- |
| HANA `Secrets` vs Credstore composition | **Keep HANA metadata-only; Credstore alias = `Secrets.key`.** No schema changes. The HANA entity stays the inventory + governance layer; Credstore stores values. |
| Plan choice + decryption library | **`default` plan + `jose` library.** Smallest surface; matches the canonical SAP Node.js sample (`btp-integration-toolkit-lite`). |
| Namespace strategy | **Single namespace `tutorials` per environment.** Each env (DEV/QA/PROD) has its own `tutorials-credstore` instance bound to its srv app. Instance-isolation by deployment, not logical-isolation by namespace. |
| Tile value-edit UX | **Set / Rotate / Clear / Reveal (Show with auto-hide).** 30-second server-supplied reveal window. CAP audit-logging records all value reads/writes. |
| Audit log surface | **Explicit `@AuditLog.Operation` annotation on `Secrets`** + per-handler `cds.audit.log()` calls for `revealSecretValue` (functions don't fire CRUD interceptors). NO separate HANA viewer-log entity. The existing `Secrets` entity does NOT have `@PersonalData` annotation (verified against `db/audit-logging.cds`) — that's correct (secret values aren't personal data per GDPR), but means the audit-logging plugin needs a security-purpose annotation, not a privacy-purpose one. |
| Vendor-side rotate UX | **Structured response `{ rotated: false, reason, rotationDocsUrl }`** so the tile renders friendly guidance rather than a 503 error toast. |
| Reveal expiry mechanism | **Server-supplied `expiresAt`** in the response. Tile auto-hides based on this — no client-side fixed timer. |

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        admin tile (Secrets.view)                     │
│                                                                      │
│  ┌────────────────────────┐    ┌───────────────────────────────────┐ │
│  │ List/Edit metadata     │    │ Value-management Panel (collapsed)│ │
│  │ (#482; UNCHANGED)      │    │  • Show value (reveal, 30s)       │ │
│  │                        │    │  • Set value                       │ │
│  │ Edit dialog            │ ── │  • Rotate value                    │ │
│  │  └ metadata fields     │    │  • Clear value                     │ │
│  │  └ NEW: Panel below ──┼────│                                     │ │
│  └────────────────────────┘    └───────────────────────────────────┘ │
└─────────────┬─────────────────────────┬──────────────────────────────┘
              │                         │
   OData V4 (CSRF for actions)      OData V4 GET (no CSRF)
              │                         │
┌─────────────▼─────────────────────────▼──────────────────────────────┐
│  AdminService projection on Secrets (#482; ADD 3 actions + 1 fn)     │
│                                                                      │
│  this.on('setSecretValue',    'Secrets', handlerSet)                 │
│  this.on('rotateSecretValue', 'Secrets', handlerRotate)              │
│  this.on('clearSecretValue',  'Secrets', handlerClear)               │
│  this.on('revealSecretValue', 'Secrets', handlerReveal)              │
└─────────────┬────────────────────────────────────────────────────────┘
              │ readSecret / writeSecret / deleteSecret
              │
┌─────────────▼────────────────────────────────────────────────────────┐
│  srv/lib/credstore.js (NEW — single chokepoint)                      │
│                                                                      │
│  • @sap/xsenv → resolve credstore binding (cached)                   │
│  • jose.compactDecrypt → JWE → plaintext                             │
│  • native fetch → HTTP/HTTPS to credstore endpoint                   │
└─────────────┬────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────┐
   │ BTP Credential Store service instance    │
   │ (tutorials-credstore, default plan)      │
   │                                          │
   │ Namespace: 'tutorials'                   │
   │ Aliases: GITHUB_DISPATCH_TOKEN,          │
   │          CONTENT_API_KEY,                │
   │          SUBMISSION_SALT_SECRET, ...     │
   └──────────────────────────────────────────┘

HANA `Secrets` table (#482; UNCHANGED)
  • Metadata: key, description, kind, rotationOwner, rotationDocsUrl,
    expiresAt, lastRotatedAt
  • `key` doubles as the credstore alias — 1:1 join
```

The HANA `Secrets` entity, the credstore, and the admin tile are loosely coupled:

- **HANA** is the inventory (search, filter, expiry-cron, change-tracking).
- **Credstore** is the value store (write-only by admin tile, read-only by srv resolvers).
- **Admin tile** is the operator UX (one tile, one dialog, both surfaces).

## File structure

### New files

| File | Purpose |
| --- | --- |
| `srv/lib/credstore.js` | Single chokepoint for all BTP Credential Store I/O (~140 lines). Read/write/delete + JWE decryption. |
| `test/unit/lib/credstore.test.js` | 6 unit tests covering JWE round-trip, 404 handling, idempotent delete, envelope unwrap. |
| `test/unit/admin-secret-value-handlers.test.js` | 8 unit tests covering the 4 handlers with credstore lib mocked. |

### Modified files

| File | Change |
| --- | --- |
| `mta.yaml` | Add `tutorials-credstore` managed-service instance + binding to srv module. |
| `db/audit-logging.cds` | Add `@AuditLog.Operation` annotation on `Secrets` for security-purpose audit (existing entity has no `@PersonalData` — verified). |
| `srv/admin-service.cds` | Add 3 actions + 1 function to existing `Secrets` projection. |
| `srv/admin-service.js` | Add 4 handlers + explicit `cds.audit.log()` calls for `revealSecretValue` / `rotateSecretValue` (custom OData functions don't fire CRUD interceptors). |
| `app/admin/secrets/webapp/view/SecretDialog.fragment.xml` | Add "Secret Value" Panel below existing metadata fields. |
| `app/admin/secrets/webapp/controller/Secrets.controller.js` | Add 5 handlers (Show / Set / Rotate / Clear + reveal countdown). |
| `app/admin/secrets/webapp/i18n/i18n.properties` | ~10 new keys (panel/button labels, dialog titles, confirm-clear text). |
| `package.json` | Add `jose ^5.x` dep. |
| `docs/developers/operations/runtime-config.md` | Append "Phase 2-C" section (the existing doc is designed to be appendable per #491). |

---

## Service binding (`mta.yaml`)

Add a new managed service instance + binding to the `srv` module:

```yaml
modules:
  - name: tutorials-srv
    requires:
      # ...existing requires...
      - name: tutorials-credstore         # NEW

resources:
  # ...existing resources...
  - name: tutorials-credstore             # NEW
    type: org.cloudfoundry.managed-service
    parameters:
      service: credstore
      service-plan: default
      config:
        authentication: basic              # default plan = basic auth + JWE response decryption
```

Binding shape (from BTP's `credstore` service contract, populated at deploy time):

```json
{
  "url": "https://credstore-...example.cloud.sap",
  "username": "<basic-auth-user>",
  "password": "<basic-auth-pwd>",
  "encryption": {
    "client_private_key": "-----BEGIN PRIVATE KEY-----\n..."
  }
}
```

Read at runtime via `xsenv.getServices({ credstore: { tag: 'credstore' } })` — same pattern other srv code uses for HANA / AI Core bindings.

**Operational concerns:**

- **Local dev** — `cds bind --to credstore --kind credentials` for hybrid local development. Same pattern as HANA. `npm run dev:hybrid` shape doesn't change.
- **Per-environment instances** — DEV / QA / PROD each get their own `tutorials-credstore` service instance bound to their srv app. Instance-isolation by deployment; no cross-env data leakage.

---

## Credstore lib (`srv/lib/credstore.js`)

Single chokepoint for all credstore I/O. ~140 lines, single-purpose, testable in isolation. Module-level binding capture (cached on first import — credstore binding doesn't change at runtime), per-call HTTP fetch (resolved on each operation since these are infrequent and cache invalidation is hard).

```javascript
// srv/lib/credstore.js
// BTP Credential Store integration. Phase 2-C (#465).
//
// Layered above @sap/xsenv (binding lookup) + native fetch + jose (JWE-decrypt).
// Single chokepoint for all credstore I/O — keeps the security audit surface
// small and makes mocking trivial in unit tests.

import { getServices } from '@sap/xsenv';
import { compactDecrypt, importPKCS8 } from 'jose';
import cds from '@sap/cds';

const LOG = cds.log('credstore');
const NAMESPACE = 'tutorials';   // single namespace per env (Phase 2-C spec)

// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS on
// Windows) doesn't produce divergent caches across instances. Same pattern as
// srv/lib/runtime-config/*-settings.js after #491 final-review fix. The memory
// has fired 4× already — preempting here.
const STATE_KEY = Symbol.for('com.sap.developers.ims:credstore');
const _state = (globalThis[STATE_KEY] ??= { binding: null, privateKey: null });

function getBinding() {
  if (_state.binding) return _state.binding;
  const services = getServices({ credstore: { tag: 'credstore' } });
  _state.binding = services.credstore;
  return _state.binding;
}
async function getPrivateKey() {
  if (_state.privateKey) return _state.privateKey;
  const binding = getBinding();
  const pem = binding.encryption?.client_private_key;
  if (!pem) {
    throw new Error('credstore binding missing encryption.client_private_key');
  }
  // jose's importPKCS8 expects PEM with proper headers. RSA-OAEP-256 matches
  // the credstore service's JWE algorithm (SAP-published).
  _state.privateKey = await importPKCS8(pem, 'RSA-OAEP-256');
  return _state.privateKey;
}

function authHeader() {
  const b = getBinding();
  const token = Buffer.from(`${b.username}:${b.password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** Read a secret value by alias. Returns the plaintext value, or null if
 *  the entry doesn't exist (404). Throws on any other error so caller can
 *  surface it. */
export async function readSecret(alias) {
  const b = getBinding();
  const url = `${b.url}/password?name=${encodeURIComponent(alias)}`;
  const res = await fetch(url, {
    headers: {
      ...authHeader(),
      'sapcp-credstore-namespace': NAMESPACE,
      Accept: 'application/jose',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`credstore read ${alias}: ${res.status}`);
  const jwe = await res.text();
  const key = await getPrivateKey();
  const { plaintext } = await compactDecrypt(jwe, key);
  // Credstore wraps the value in a JSON envelope: { value: "...", ... }
  const envelope = JSON.parse(new TextDecoder().decode(plaintext));
  return envelope.value;
}

/** Write a secret value by alias. Creates the entry if missing, updates if
 *  present. Returns true on success. */
export async function writeSecret(alias, value) {
  const b = getBinding();
  const url = `${b.url}/password`;
  const body = { name: alias, value };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'sapcp-credstore-namespace': NAMESPACE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`credstore write ${alias}: ${res.status} ${detail.slice(0, 200)}`);
  }
  LOG.info(`credstore: wrote secret ${alias}`);
  return true;
}

/** Delete a secret by alias. Returns true on success or 404 (already gone). */
export async function deleteSecret(alias) {
  const b = getBinding();
  const url = `${b.url}/password?name=${encodeURIComponent(alias)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...authHeader(), 'sapcp-credstore-namespace': NAMESPACE },
  });
  if (res.status === 404) return true;       // idempotent delete
  if (!res.ok) throw new Error(`credstore delete ${alias}: ${res.status}`);
  LOG.info(`credstore: deleted secret ${alias}`);
  return true;
}

/** Test-only: clear cached binding so unit tests can swap mocks. */
export function _resetForTests() {
  _state.binding = null;
  _state.privateKey = null;
}
```

**Notes:**

- `compactDecrypt` from `jose` does both JWE decryption AND algorithm/key validation in one call. No room for "wrong algorithm accepted" foot-guns.
- `importPKCS8(pem, 'RSA-OAEP-256')` pins the expected algorithm. If the credstore service ever returns a different algorithm header in the JWE, `compactDecrypt` will reject — defense against algorithm-confusion attacks.
- The `envelope.value` unwrap is the credstore's wire format quirk — values come wrapped in `{ value: "..." }` on the JWE plaintext. Unit-tested explicitly so a future credstore version that changes the envelope shape fails loudly.
- **No retry logic.** Credstore failures surface to the caller. Retries on credential operations are usually wrong (a write that "failed" might have actually succeeded; a retry creates a duplicate or overwrites unrelated state). Better to surface and let admin retry manually.
- **Idempotent delete (404 → true)** so admins clearing a non-existent value see success rather than a confusing error.

---

## AdminService surface (`srv/admin-service.cds`)

Add 4 OData operations to the existing `Secrets` projection. All inherit `@requires:'Admin'` from the projection.

```cds
@requires: 'Admin'
entity Secrets as projection on ims.Secrets actions {

  // Set a secret's value in BTP Credential Store. If a value already exists,
  // overwrites. Returns success indicator + updates lastRotatedAt as a
  // side-effect (admins see immediate feedback in the tile).
  action setSecretValue(value: String) returns {
    written : Boolean;
    lastRotatedAt : Timestamp;
  };

  // Generate a fresh value AND write it. For kind='salt' / 'content-api-key',
  // generates 32 bytes hex via crypto.randomBytes. For vendor-side kinds
  // (github-pat / service-key / smtp-credential / other), returns a structured
  // guidance response so the tile can render a friendly dialog pointing at
  // the rotationDocsUrl rather than surfacing a 503 error toast.
  action rotateSecretValue() returns {
    rotated : Boolean;
    reason : String;          // 'self-generated' | 'vendor-side'
    newValue : String;        // populated only when rotated=true
    written : Boolean;        // populated only when rotated=true
    lastRotatedAt : Timestamp;
    revealExpiresAt : Timestamp;
    rotationDocsUrl : String; // populated when rotated=false (echoed from Secrets row)
  };

  // Delete the credstore entry for this secret. Keeps the HANA metadata row
  // (deletion of the metadata is a separate operation via the projection's
  // standard DELETE). Idempotent — clearing a non-existent value is a no-op.
  action clearSecretValue() returns {
    cleared : Boolean;
  };

  // Reveal the current secret value for short-lived display in the admin tile.
  // Returns the plaintext + a server-supplied expiresAt (~30s). Tile auto-hides
  // when expiresAt elapses. Each invocation emits a SecretValueRead audit-log
  // event tagged with the calling user's identity.
  function revealSecretValue() returns {
    value : String;
    expiresAt : Timestamp;
  };
};
```

**Notes:**

- All 4 operations are bound to `Secrets` (not unbound) — the OData URL is `/admin/Secrets(<ID>)/AdminService.<actionName>`. The handler reads `req.params[0].ID` and looks up the `key` from that row to use as the credstore alias.
- `rotateSecretValue` returns plaintext (the `newValue`) because admins often need to update other systems with the rotated value (paste into GitHub Actions secret, etc.). The reveal-expiry mechanism keeps exposure bounded.
- Vendor-side kinds (kind ∉ {salt, content-api-key}) return `{ rotated: false, reason: 'vendor-side', rotationDocsUrl }`. The tile renders a guidance dialog with the rotationDocsUrl as a link + a "paste new value here" bridge into the Set flow.
- `revealSecretValue` is a **function** (GET), not an action — read-only by definition. CSRF token NOT required. Handler MUST set `Cache-Control: no-store, no-cache, must-revalidate` on the response.
- `lastRotatedAt` is updated as a side-effect on `setSecretValue` and `rotateSecretValue` writes. Admin tile picks up the new timestamp on next refresh. No separate `markRotated()` action needed.

---

## Handlers (`srv/admin-service.js`)

4 handlers, ~80 lines total, sit alongside the existing `secretWarnings` handler at line ~990.

```javascript
import { readSecret, writeSecret, deleteSecret } from './lib/credstore.js';
import { randomBytes } from 'node:crypto';

// ~30 second reveal window. Server-supplied; tile auto-hides on this expiry.
const REVEAL_WINDOW_MS = 30_000;

// Self-generate-able kinds — admin clicks Rotate, server mints + writes.
const SELF_GEN_KINDS = new Set(['salt', 'content-api-key']);

// ────────────────────────────────────────────────────────────────────────────
// Helper: load the Secrets row by ID. All 4 handlers need this.
async function loadSecretRow(req) {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const id = req.params[0].ID;
  const row = await SELECT.one.from(Secrets).where({ ID: id });
  if (!row) req.reject(404, 'Secret not found');
  return row;
}

// Helper: stamp lastRotatedAt on the row.
async function stampRotated(id) {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const ts = new Date();
  await UPDATE(Secrets).set({ lastRotatedAt: ts }).where({ ID: id });
  return ts;
}

// ────────────────────────────────────────────────────────────────────────────
this.on('setSecretValue', 'Secrets', async (req) => {
  const row = await loadSecretRow(req);
  const { value } = req.data;
  if (!value || typeof value !== 'string') {
    return req.reject(400, 'value (non-empty string) is required');
  }
  await writeSecret(row.key, value);
  const lastRotatedAt = await stampRotated(row.ID);
  return { written: true, lastRotatedAt };
});

// ────────────────────────────────────────────────────────────────────────────
this.on('rotateSecretValue', 'Secrets', async (req) => {
  const row = await loadSecretRow(req);
  if (!SELF_GEN_KINDS.has(row.kind)) {
    return {
      rotated: false,
      reason: 'vendor-side',
      newValue: '',
      written: false,
      lastRotatedAt: null,
      revealExpiresAt: null,
      rotationDocsUrl: row.rotationDocsUrl ?? '',
    };
  }
  // 32 bytes hex = 64-char string. Strong enough for both salt and api-key.
  const newValue = randomBytes(32).toString('hex');
  await writeSecret(row.key, newValue);
  const lastRotatedAt = await stampRotated(row.ID);
  const revealExpiresAt = new Date(Date.now() + REVEAL_WINDOW_MS);
  return {
    rotated: true,
    reason: 'self-generated',
    newValue,
    written: true,
    lastRotatedAt,
    revealExpiresAt,
    rotationDocsUrl: '',
  };
});

// ────────────────────────────────────────────────────────────────────────────
this.on('clearSecretValue', 'Secrets', async (req) => {
  const row = await loadSecretRow(req);
  await deleteSecret(row.key);
  return { cleared: true };
});

// ────────────────────────────────────────────────────────────────────────────
this.on('revealSecretValue', 'Secrets', async (req) => {
  const row = await loadSecretRow(req);
  const value = await readSecret(row.key);
  if (value == null) return req.reject(404, 'No value stored for this secret');

  // Defense-in-depth: don't let proxies cache the response, even though
  // /admin/* is XSUAA-gated and not normally proxy-cached. `private` for
  // shared-cache defense; `no-store` is the strict directive.
  if (req._.res) {
    req._.res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    req._.res.setHeader('Pragma', 'no-cache');
  }

  return {
    value,
    expiresAt: new Date(Date.now() + REVEAL_WINDOW_MS),
  };
});
```

**Notes:**

- `req.params[0].ID` is the bound-action's parameter shape in CAP. `Secrets(ID=<uuid>)/AdminService.setSecretValue` parses to `req.params = [{ ID: '<uuid>' }]`. Tested pattern from existing bound actions like Joule's `seedEmbeddings`.
- `req._.res` is the underlying Express response — CAP exposes it for cases like this where you need to set HTTP-level headers. Documented but seldom-needed; here it's the cleanest way to add `Cache-Control` on reveal responses.
- The discriminated-union response in `rotateSecretValue` populates ALL fields (with empty strings / nulls for the inactive branch) so OData's marshalling is predictable. Strict-typed clients see the full shape; the tile's controller branches on `result.rotated`.
- `if (value == null)` in reveal distinguishes "metadata exists but no value set" from "metadata doesn't exist" (the latter caught by `loadSecretRow`). Friendly UX: the tile shows "No value yet — click Set Value to add one."
- **Audit-logging strategy** — the existing `Secrets` entity has NO `@PersonalData` annotation in `db/audit-logging.cds` (verified). Secret values aren't personal data per GDPR semantics, so the GDPR-purpose annotation doesn't apply. Phase 2-C adds a security-purpose `@AuditLog.Operation` annotation on the entity (per the `@cap-js/audit-logging` plugin's documented API) for CRUD events on `Secrets` — this captures `setSecretValue` (which writes via `UPDATE` for `lastRotatedAt`) and `clearSecretValue` (which doesn't UPDATE Secrets but mutates state). For `revealSecretValue` and `rotateSecretValue`'s value-emit specifically, **the handlers must call `cds.audit.log()` (or the plugin's API equivalent) explicitly** — custom OData V4 actions/functions don't fire the plugin's CRUD interceptors automatically. Plan-task includes both: (a) annotation on the projection, (b) explicit `cds.audit.log()` calls in revealSecretValue + rotateSecretValue handlers tagged with `SecretValueRead` / `SecretValueRotate` event names.

---

## Admin tile UX (`app/admin/secrets/`)

Existing #482 tile has list-report + per-row Edit/Delete dialog (metadata only). Phase 2-C adds value-management on top — without redesigning the existing surface.

### View additions (`view/SecretDialog.fragment.xml`)

Add a collapsible Panel below the existing metadata fields — "Secret Value" — with reveal area + 4 buttons:

```xml
<Panel headerText="{i18n>panelSecretValue}" expandable="true" expanded="false">

  <!-- Reveal area: hidden by default. When user clicks "Show value",
       fetch revealSecretValue() and populate. Auto-hide on revealExpiresAt. -->
  <VBox visible="{= !!${dialog>/revealedValue}}" class="sapUiSmallMarginBottom">
    <MessageStrip
      text="{= 'Value visible for ' + ${dialog>/revealSecondsLeft} + 's. Logged in audit trail.' }"
      type="Warning"
      showIcon="true" />
    <Input
      value="{dialog>/revealedValue}"
      editable="false"
      class="sapUiSmallMarginTop">
      <layoutData>
        <FlexItemData growFactor="1" />
      </layoutData>
    </Input>
  </VBox>

  <!-- Action buttons. Always visible regardless of reveal state. -->
  <HBox justifyContent="Start" alignItems="Center">
    <Button
      text="{i18n>buttonShowValue}"
      icon="sap-icon://show"
      press=".onRevealValue"
      enabled="{= !${dialog>/isNew}}" />
    <Button
      text="{i18n>buttonSetValue}"
      icon="sap-icon://edit"
      press=".onSetValue"
      enabled="{= !${dialog>/isNew}}"
      class="sapUiTinyMarginBegin" />
    <Button
      text="{i18n>buttonRotate}"
      icon="sap-icon://refresh"
      press=".onRotate"
      enabled="{= !${dialog>/isNew}}"
      class="sapUiTinyMarginBegin" />
    <Button
      text="{i18n>buttonClear}"
      icon="sap-icon://delete"
      press=".onClearValue"
      enabled="{= !${dialog>/isNew}}"
      type="Reject"
      class="sapUiTinyMarginBegin" />
  </HBox>

</Panel>
```

The 4 buttons are disabled when `isNew=true` (new metadata row hasn't been saved — can't write to credstore against an unsaved key). After Save in the existing metadata flow, `isNew` flips false and value-edit becomes available.

### Controller additions (`controller/Secrets.controller.js`)

5 new handlers + reveal-countdown ticker:

```javascript
// Helper: invoke a bound action via OData V4 + CSRF round-trip.
// Uses the existing controller's `_withCsrf(callback)` callback-style helper
// at line 178 of Secrets.controller.js. We bind it to `this` so callers can
// `await this._invokeBoundAction(...)` from any handler method.
_invokeBoundAction: function (secretId, actionName, body) {
  const url = `/admin/Secrets(${secretId})/AdminService.${actionName}`;
  return this._withCsrf((token) =>
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': token,
      },
      body: JSON.stringify(body || {}),
    })
  ).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  });
},

// ────────────────────────────────────────────────────────────────────────────
onRevealValue: async function () {
  const data = this.getView().getModel("dialog").getData();
  // Reveal is a *function* (GET) not action — different URL shape, no CSRF.
  const res = await fetch(
    `/admin/Secrets(${data.ID})/AdminService.revealSecretValue()`,
    { credentials: 'include', headers: { Accept: 'application/json' } }
  );
  if (!res.ok) {
    const detail = await res.text();
    sap.m.MessageBox.error("Reveal failed: " + (detail || res.status));
    return;
  }
  const result = await res.json();
  this._startRevealCountdown(result.value, new Date(result.expiresAt));
},

// ────────────────────────────────────────────────────────────────────────────
onSetValue: function () {
  const self = this;
  const data = this.getView().getModel("dialog").getData();
  // Use a sap.m.Dialog with a single masked Input field.
  // Show "Type or paste new value, click Save."
  this._openSetValueDialog((value) => {
    return self._invokeBoundAction(data.ID, 'setSecretValue', { value })
      .then((result) => {
        // Update lastRotatedAt in the parent dialog model
        self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
        sap.m.MessageToast.show("Value saved.");
      });
  });
},

// ────────────────────────────────────────────────────────────────────────────
onRotate: async function () {
  const data = this.getView().getModel("dialog").getData();
  const result = await this._invokeBoundAction(data.ID, 'rotateSecretValue', {});
  if (result.rotated === true) {
    // Self-generated: update lastRotatedAt + show new value in a guidance dialog
    this.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
    this._showRotatedValueDialog(result.newValue, new Date(result.revealExpiresAt));
  } else {
    // Vendor-side: show guidance dialog with rotationDocsUrl + "paste new value" bridge
    this._showVendorRotationGuidance(result.rotationDocsUrl, data.ID);
  }
},

// ────────────────────────────────────────────────────────────────────────────
onClearValue: function () {
  const self = this;
  const data = this.getView().getModel("dialog").getData();
  sap.m.MessageBox.confirm(
    "Delete the credstore value for '" + data.key + "'? Metadata stays in HANA.",
    {
      onClose: async (action) => {
        if (action !== "OK") return;
        await self._invokeBoundAction(data.ID, 'clearSecretValue', {});
        sap.m.MessageToast.show("Value cleared.");
      }
    }
  );
},

// ────────────────────────────────────────────────────────────────────────────
// Reveal countdown — server-supplied expiry; clamped against negative drift.
// Tracks the active timer so a 2nd Show click cancels the 1st ticker (race fix).
_startRevealCountdown: function (value, expiresAt) {
  if (this._revealTickerId) {
    clearTimeout(this._revealTickerId);
    this._revealTickerId = null;
  }
  const model = this.getView().getModel("dialog");
  model.setProperty("/revealedValue", value);
  this._tickReveal(model, expiresAt);
},

_tickReveal: function (model, expiresAt) {
  const now = Date.now();
  const remaining = Math.max(0, expiresAt.getTime() - now);
  model.setProperty("/revealSecondsLeft", Math.ceil(remaining / 1000));
  if (remaining <= 0) {
    model.setProperty("/revealedValue", "");
    model.setProperty("/revealSecondsLeft", 0);
    this._revealTickerId = null;
    return;
  }
  // Re-tick once per second until expiry. setTimeout (vs setInterval) chosen
  // so the displayed countdown stays in sync with the server-supplied
  // expiresAt even when the tab is backgrounded (browsers throttle setInterval
  // aggressively in background tabs but re-bias each setTimeout against the
  // wall-clock).
  this._revealTickerId = setTimeout(
    () => this._tickReveal(model, expiresAt),
    1000
  );
},
```

**Vendor-side rotation bridge** — `_showVendorRotationGuidance(rotationDocsUrl, secretId)` shows a dialog with:

1. The `rotationDocsUrl` as a clickable link.
2. A `[I've completed rotation, paste the new value]` button that opens the same masked-input dialog as `onSetValue`. This bridges the two-step flow: admin goes to vendor UI to mint a new credential, comes back, pastes the new value. Tile records the lastRotatedAt timestamp on save.

### i18n additions (`app/admin/secrets/webapp/i18n/i18n.properties`)

~10 new keys:

- `panelSecretValue` — "Secret Value"
- `buttonShowValue` — "Show Value"
- `buttonSetValue` — "Set Value"
- `buttonRotate` — "Rotate"
- `buttonClear` — "Clear Value"
- `dialogTitleSetValue` — "Set Secret Value"
- `dialogTitleRotated` — "Value Rotated"
- `dialogTitleVendorRotation` — "Vendor-Side Rotation"
- `confirmClearValue` — "Delete the credstore value for '{0}'? Metadata stays in HANA."
- `revealMessageStrip` — "Value visible for {0}s. Logged in audit trail."

---

## Tests

Unit-only this PR, matching the runtime-config precedent (#471/#482/#491). Hybrid tests deliberately out of scope — first DEV deploy is the smoke test for real credstore integration.

### `test/unit/lib/credstore.test.js` (6 cases)

- `readSecret` returns null on 404 (entry doesn't exist)
- `readSecret` throws on non-200/404 (network error, auth failure)
- `writeSecret` POSTs to `/password` with namespace + Basic auth headers
- `deleteSecret` returns true on 200 AND on 404 (idempotent semantics)
- JWE-decrypt round-trip with a fixture private key + fixture JWE blob
- Unwraps the credstore `{ value: "..." }` envelope correctly

Test fixture: a pre-generated PKCS8 private key + a corresponding JWE blob containing `{"value":"test-secret"}` encrypted with the matching public key. Generated once via a setup script; checked into the test fixture directory.

### `test/unit/admin-secret-value-handlers.test.js` (8 cases)

- `setSecretValue` happy-path: writes credstore + stamps lastRotatedAt
- `setSecretValue` rejects empty / missing value with 400
- `rotateSecretValue` self-gen kind ('salt'): mints 64-char hex + writes
- `rotateSecretValue` self-gen kind ('content-api-key'): same shape, hex value
- `rotateSecretValue` vendor-side kind ('github-pat'): returns rotated:false + rotationDocsUrl
- `clearSecretValue` happy-path: deletes credstore, returns cleared:true
- `revealSecretValue` happy-path: returns value + expiresAt ~30s ahead
- `revealSecretValue` when no value stored: rejects with 404

Each handler test mocks `srv/lib/credstore.js` via `vi.spyOn(credstoreModule, 'writeSecret').mockResolvedValue(true)` etc. Same pattern as Phase 3's resolver mocking in `rebuild-trigger.test.js`. Lib-level JWE-decrypt is unit-tested separately, so handler tests can mock without losing crypto coverage.

### Tests intentionally out of scope

- **Hybrid round-trip against real DEV credstore.** Same rationale as runtime-config: would consume real credstore quota; first DEV deploy is the smoke.
- **Reveal-countdown UI tests.** UI5 timer-driven UI is hard to test in isolation; manual smoke during DEV deploy verifies the auto-hide behavior.
- **Audit-log emission.** `@cap-js/audit-logging` is plugin-driven; coverage exists at the plugin level. Project-specific test would just verify the plugin is wired, which the existing `Secrets` annotations from #482 already do.

---

## Acceptance criteria (from issue #465)

- [x] Phase 2-C feature gated on encryption-key decision = COMPLETE (Option B = BTP Credential Store, per-secret entries).
- [x] Phase 2-C feature gated on subaccount entitlement = COMPLETE (Tom verified 2026-06-20).
- [ ] Phase 2-C feature gated on security review = scope reduced to "review the spec doc against SAP's BTP Credential Store security guarantees" (no custom crypto to audit). Run in parallel with implementation.
- [ ] All 4 OData operations (Set / Rotate / Clear / Reveal) work end-to-end against a real DEV credstore (manual smoke).
- [ ] Reveal flow: value visible for ~30s, auto-hides, audit-log entry written.
- [ ] Set / Rotate / Clear flows: write to credstore, lastRotatedAt updates, audit-log entry written.
- [ ] Vendor-side rotate flow: shows guidance dialog with rotationDocsUrl + "paste new value" bridge.
- [ ] All credstore operations route through `srv/lib/credstore.js` (single chokepoint).
- [ ] `mta.yaml` binds the `tutorials-credstore` service instance to srv module.
- [ ] **PR body call-out** for the security trade-offs of Show/Hide UX (browser DevTools, screenshare, autosave risks) + the audit-log mitigation.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| BTP Credential Store binding absent in DEV at deploy time → handler 503 | `srv/lib/credstore.js getBinding()` throws clear error; admin handlers catch + `req.reject(503, 'Credential Store not configured')`. Tile shows error message, doesn't crash. |
| `jose` library not on security-approved list | `jose` is the de-facto Node JWE standard, used by every major OIDC implementation. Confirm with security partner during review; if blocked, fall back to `mtls` plan (no app-side decrypt). |
| Reveal value cached by browser DevTools / proxy | `Cache-Control: no-store, no-cache, must-revalidate` set in handler. `/admin/*` is XSUAA-gated — no shared proxy cache. Admin laptop DevTools is in scope; the audit-log + 30s auto-hide are the documented mitigations. |
| Admin clicks Reveal during screenshare → value visible to viewers | Out-of-band UX risk (same as 1Password / Bitwarden). MessageStrip text "Value visible for Ns. Logged in audit trail." gives admin pause. Auto-hide bounds exposure. |
| Vendor-side rotate "paste new value" bridge gives admin a way to write any string to credstore as the rotation | Intentional. The credstore is the source of truth; metadata's `lastRotatedAt` is admin-asserted. Trust model: admins are admins. Audit-log captures the write. |
| `revealSecondsLeft` ticker drifts on slow client → off-by-1 | `_tickReveal` clamps `Math.max(0, ...)` so negative drift never produces negative timeout. Acceptable. |
| `lastRotatedAt` update races with another admin editing the same row | Last-write-wins on the column. Acceptable for low-contention admin tile (single admin team, no realistic concurrent edits). |
| BTP entitlement quota exceeded at deploy | Tom confirmed quota available 2026-06-20. Verify before deploy via `btp_service_instances` MCP. |
| `cds bind --to credstore` for local hybrid dev not yet documented | Plan task adds doc note in `docs/developers/operations/runtime-config.md` (extending the existing runtime-config doc). |
| Module-singleton multiplicity in tests (Vitest+CDS+Windows; fired 4× already per [feedback_module_singletons_in_vitest_cds]) | `srv/lib/credstore.js` uses globalThis-keyed cache pattern from start (see lib code: `Symbol.for('com.sap.developers.ims:credstore')` + `globalThis[STATE_KEY] ??= {...}`). Same pattern as runtime-config resolvers post-#491-fix. Preempts a 5th occurrence. |
| JWE algorithm-confusion (credstore service starts emitting different alg) | `compactDecrypt(jwe, importPKCS8(pem, 'RSA-OAEP-256'))` pins the algorithm. If the service ever returns a different alg header, jose rejects via the algorithm-list pin. Defense-in-depth. |
| Secret values containing JSON-special chars (quotes, newlines, Unicode) | `JSON.stringify({ name, value })` handles native — no manual escaping needed. Round-trip unit-tested with a fixture containing `"\\n\\u00e9` characters to catch regressions. |
| Reveal double-click race (admin clicks Show twice within 30s → 2 tickers compete) | `_startRevealCountdown` cancels any prior `_revealTickerId` before scheduling a new one. Tested by clicking twice in DEV smoke. |
| `req._.res.setHeader` is CAP internal (`req._` is a private state bag, may break on minor-version bump) | Plan task: verify `req._.res.setHeader` works in current `@sap/cds` version during DEV smoke. Fallback if it breaks: srv-level express `app.use` middleware keyed on the `revealSecretValue` URL pattern (more code, more stable seat). Add `private` to the `Cache-Control` header for shared-cache defense. |
| `service-plan: default` and `authentication: basic` may have been renamed | Before deploy, run `cf marketplace -e credstore` (or `btp_service_instances` MCP) to confirm catalog plan name is still `default`. SAP renamed `standard` → `default` historically; reverse rename is unlikely but worth a 30-second check. |

---

## Out of scope (defer to follow-up issues)

- **Multi-namespace credstore** for multi-tenant scenarios. Single namespace per env is the choice.
- **`listSecrets()` from credstore.** HANA `Secrets` is the inventory; no need to enumerate from credstore.
- **Reveal auto-extends if admin is actively typing/copying.** Just rerun Show; explicit re-fetch.
- **Programmatic rotation handlers per-kind for vendor-side secrets** (e.g. auto-mint GitHub PAT via API). Phase 3+ if visibility-only proves insufficient.
- **HANA-side viewer-log entity for revealed values.** CAP audit-logging is the canonical record.
- **mTLS plan** for the credstore binding. Default plan + JWE is sufficient for our threat model; mTLS is a Phase 4+ hardening if security review pushes back.

---

## PR body skeleton

```markdown
# feat: Phase 2-C encrypted secrets store via BTP Credential Store (#465)

Closes #465. Final phase of the runtime-config research from #444.

Adds value-storage to the existing `Secrets` HANA entity (metadata-only
from #482). Values live in BTP Credential Store keyed by `Secrets.key`
as the credstore alias. HANA stays metadata-only — no schema migration.

## ⚠️ Security trade-offs documented

The "Show Value" admin-tile button reveals secret values for 30s before
auto-hiding. Three known leak paths, all bounded:

1. **Browser DevTools network panel** logs the response body. Mitigated
   by `Cache-Control: no-store` + audit-log entry on every reveal.
2. **Screenshare during reveal** exposes the masked-then-revealed field.
   MessageStrip "Value visible for Ns. Logged in audit trail." gives
   admin pause before clicking.
3. **Browser autosave / password-manager extensions** could capture
   revealed values. Out-of-band — admin's local laptop hygiene.

CAP audit-logging records every reveal with the calling admin's identity.
This is the documented trade-off for usability — admins commonly need to
copy a current value (e.g. test a token) without rotating.

## What's in the PR

- `srv/lib/credstore.js` — single chokepoint for all credstore I/O
- 3 actions + 1 function on the `Secrets` AdminService projection
- 4 handlers in admin-service.js (Set / Rotate / Clear / Reveal)
- Admin tile dialog: new "Secret Value" Panel below metadata fields
- 5 controller handlers + reveal-countdown ticker
- 14 unit tests (6 lib + 8 handler)
- `mta.yaml` adds tutorials-credstore service binding
- `package.json` adds `jose` dep
- Operations doc extended with Phase 2-C section

## ⚠️ One known gap (intentional)

Vendor-side rotate kinds (`github-pat`, `service-key`, `smtp-credential`,
`other`) cannot be self-rotated via the tile. The Rotate button shows a
guidance dialog with the rotationDocsUrl as a link + a "paste new value"
bridge into the Set flow. Programmatic vendor rotation is a Phase 3+
follow-up (cost: per-kind handler + recursive auth).

## Test Plan

- [x] Unit tests pass (14 cases)
- [ ] DEV deploy: tile loads with Secret Value Panel
- [ ] DEV deploy: Set / Rotate / Clear / Reveal all work end-to-end
- [ ] DEV deploy: reveal auto-hides at 30s
- [ ] DEV deploy: audit-log captures reveals + writes
- [ ] DEV deploy: vendor-side Rotate shows guidance dialog

## Out of scope

- Multi-namespace credstore (single namespace per env)
- `listSecrets()` from credstore (HANA is the inventory)
- Programmatic per-kind vendor rotation (Phase 3+)
- mTLS plan for binding (Phase 4+ hardening)
```

---

## References

- Spec: `docs/superpowers/specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md` (this doc)
- Research-design parent: `docs/superpowers/specs/2026-06-20-runtime-config-research-design.md`
- Sibling Phase 2-A spec (#463 / PR #471): `docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md`
- Sibling Phase 2-B spec (#464 / PR #482): `docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md`
- Sibling Phase 3 spec (#466 / PR #491): `docs/superpowers/specs/2026-06-20-issue-466-long-tail-env-migration-design.md`
- Issue: [#465](https://github.com/sap-tutorials/tutorials-ims/issues/465)
- Memory: [feedback_module_singletons_in_vitest_cds] (4× fired now), [sbss_deprecated], [tom_authored_sbss_samples] (historical context for why we landed on Option B)

## Canonical SAP samples consulted

- [SAP-samples/btp-integration-toolkit-lite — CredentialStore.js](https://github.com/SAP-samples/btp-integration-toolkit-lite/blob/main/srv/handlers/lib/CredentialStore.js) — Node.js Credential Store wrapper (xsenv binding + JWE decrypt). Pattern source for `srv/lib/credstore.js`.
- [SAP-samples/btp-neo-java-app-migration — CredStoreClient.java](https://github.com/SAP-samples/btp-neo-java-app-migration/blob/main/scenarios/keystore/credential-store-client/src/main/java/com/sap/cloud/sample/credstore/client/CredStoreClient.java) — REST endpoint surface (`/password`, `/key`, `/credential` + namespace header).
