# Phase 2-C Encrypted Secrets via BTP Credential Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add encrypted-value storage to the existing `Secrets` HANA entity (metadata-only from #482) via BTP Credential Store. HANA stays metadata-only; values live in credstore keyed by `Secrets.key`. Admin tile gains Set / Rotate / Clear / Reveal operations with a 30-second auto-hide window.

**Architecture:** Single chokepoint at `srv/lib/credstore.js` (globalThis-keyed cache, JWE-decrypt via `jose`, native fetch). 3 actions + 1 function on AdminService `Secrets` projection. Admin tile dialog gains a collapsible "Secret Value" Panel. CAP audit-logging via `@AuditLog.Operation` annotation on `Secrets` + explicit `audit.log()` calls via `cds.connect.to('audit-log')` in the value-operation handlers (custom OData functions don't fire CRUD interceptors). NO schema migration — HANA `Secrets` entity unchanged.

**Tech Stack:** SAP CAP Node.js, BTP Credential Store (default plan + JWE), `jose` (new dep), `@sap/xsenv` (already a dep), Vitest (unit-only), UI5 v1.136.

**Spec:** [docs/superpowers/specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md](../specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md)

**Branch:** `worktree-issue-465-encrypted-secrets-credstore` (already checked out in worktree).

## Explicit out-of-scope (NICE-TO-HAVE callout, top-of-plan)

This plan delivers **storage + UI** for encrypted secret values. Deliberately deferred:

- **Rotation automation** — programmatic vendor-side rotation (e.g. auto-mint a fresh GitHub PAT via GitHub API) is Phase 3+.
- **Key-versioning / history** — credstore writes overwrite; old values aren't kept for rollback. If a write goes wrong, fix-forward.
- **Hybrid ciphertext-in-HANA** — values live ONLY in credstore. No fallback "encrypted blob in HANA" path. If credstore is unavailable, value operations fail loudly.
- **Multi-namespace** — single `tutorials` namespace per env (DEV / QA / PROD each get their own service instance).
- **`listSecrets()` from credstore** — HANA `Secrets` row table IS the inventory.
- **mTLS for credstore binding** — `default` plan + basic auth + JWE-on-wire is sufficient per spec.

## Commit-checkpoint reminders (NICE-TO-HAVE callout)

Every Task below ends with a `git add ... && git commit -m "..."` step. Treat each Task's commit as a checkpoint:

- Run the Task's verification (`node --check`, `npx vitest`, `npx cds compile`, etc.) BEFORE the commit.
- If verification fails, fix forward — do NOT commit broken state.
- After a successful commit, the worktree is recoverable to that point even if the next Task breaks.

## Rollback notes (NICE-TO-HAVE callout)

Each Task is independently revertable. If a Task lands but later proves wrong:

- **Tasks 1-3 (deps + binding + audit annotation):** `git revert <task-commit-sha>` is safe; no runtime state created yet.
- **Task 4 (credstore.js created):** revert is safe; no consumers yet.
- **Tasks 5-6 (CDS + handlers):** revert pair together; partial revert (e.g. revert handlers but keep CDS) leaves the OData surface broken at boot.
- **Task 2 mta.yaml edit:** if the bound credstore service instance was already provisioned in CF, `cf delete-service tutorials-credstore` is the cleanup. The mta.yaml revert by itself leaves the instance running but unbound.
- **Task 9-11 (UI):** safe to revert independently; UI is consumer of backend, not the other way.
- **End-of-flow:** if PR review demands a full retreat, `git reset --hard origin/main` on the worktree branch wipes all 12 commits cleanly.

---

## Worktree state (verified pre-flight)

Branched from main **AFTER** all 4 prior PRs merged. Verified via inspection:

- `srv/lib/runtime-config/kg-settings.js` exists (#471 Phase 2-A) ✓
- `srv/jobs/secret-expiry-check.js` exists (#482 Phase 2-B) ✓
- `srv/lib/runtime-config/{ui-events,search,navigator,display,tenant}-settings.js` exist (#491 Phase 3) ✓
- `Secrets` entity at `db/schema.cds` (metadata-only: 7 columns + `@assert.unique` on `key`) ✓
- Existing `secretWarnings` handler at `srv/admin-service.js:990` ✓
- Existing `_withCsrf(callback)` helper at `app/admin/secrets/webapp/controller/Secrets.controller.js:178` ✓
- `db/audit-logging.cds` exists; uses `@PersonalData` for Users / UserMetaData / etc. **NO existing `@AuditLog.Operation` precedent — Phase 2-C is the first user of that annotation in this codebase.**

**No rebase risk expected.** No worktree-state-aware branching needed in this plan.

---

## File Structure

### New files (3)

| File | Purpose |
| --- | --- |
| `srv/lib/credstore.js` | Single chokepoint for all BTP Credential Store I/O (~140 lines). Read/write/delete + JWE decryption. globalThis-keyed cache. |
| `test/unit/lib/credstore.test.js` | 6 unit tests (JWE round-trip, 404 handling, idempotent delete, envelope unwrap). |
| `test/unit/admin-secret-value-handlers.test.js` | 8 unit tests (4 handlers × happy + edge cases). |

### Modified files (7)

| File | Change |
| --- | --- |
| `package.json` | Add `jose ^5.x` dep. |
| `mta.yaml` | Add `tutorials-credstore` managed-service instance + binding to srv module. |
| `.deploy/mta.yaml` | Same `tutorials-credstore` resource + binding edits as root `mta.yaml` (CI builds from this file). ALSO add `../../srv/lib/credstore.js` to the srv-qa module's hand-curated cp chain. |
| `db/audit-logging.cds` | Append `@AuditLog.Operation` annotation on `ims.Secrets` (security-purpose, NOT GDPR-purpose). |
| `srv/admin-service.cds` | Add 3 actions + 1 function to existing `Secrets` projection. |
| `srv/admin-service.js` | Add 4 handlers + explicit `audit.log()` calls (via `cds.connect.to('audit-log')`) for revealSecretValue / rotateSecretValue. |
| `app/admin/secrets/webapp/view/SecretDialog.fragment.xml` | Add collapsible "Secret Value" Panel below metadata fields. |
| `app/admin/secrets/webapp/controller/Secrets.controller.js` | Add 5 handlers + `_invokeBoundAction` helper + reveal countdown ticker. |
| `app/admin/secrets/webapp/i18n/i18n.properties` | ~10 new keys (panel/button labels, dialog titles, confirm-clear). |
| `docs/developers/operations/runtime-config.md` | Append "Phase 2-C" section (the existing doc is designed to be appendable). |

### Worktree note: dual `mta.yaml` files + srv-qa cp-list (BLOCKING — verified)

There are **TWO** mta.yaml files in this repo, AND they have different content (`diff -q mta.yaml .deploy/mta.yaml` reports "differ" — verified via grep on 2026-06-21):

- Root `mta.yaml` — used for some local-dev deploys.
- `.deploy/mta.yaml` — used by CI (`deploy.yml`) for production builds.

**Both files must receive the `tutorials-credstore` resource + binding edits.** Task 2 below does both.

Additionally, `.deploy/mta.yaml` has a `srv-qa` module whose `build-parameters.commands` step is **one long bash line** that hand-lists every individual file to `cp` from `srv/lib/`, `srv/handlers/`, and `srv/jobs/` (around line 97). The new `srv/lib/credstore.js` is NOT in that list — without an explicit cp edit, the QA channel crashes on boot trying to `require('./lib/credstore')`. Memory `feedback_srv_qa_cp_list_recurring` has fired 2-3× on this codebase already. Task 2 below appends `../../srv/lib/credstore.js` to the srv-qa cp chain.

---

## Pre-flight (Step 0)

Before any task, the implementer subagent runs these checks. Each should return the expected output; any deviation means STOP and re-orient.

- [ ] **Step 0.1: Confirm working in the worktree**

  ```bash
  cd D:/projects/tutorials-poc/.claude/worktrees/issue-465-encrypted-secrets-credstore
  pwd
  git branch --show-current
  ```

  Expected: pwd ends in `issue-465-encrypted-secrets-credstore`; branch is `worktree-issue-465-encrypted-secrets-credstore`.

  Memory [[feedback_subagent_writes_can_leak_to_parent_repo]]: if you write files to the parent `D:/projects/tutorials-poc/` instead of this worktree, they'll be missed by the rebase + push. STOP and re-`cd` if wrong.

- [ ] **Step 0.2: Verify prior PRs are in this worktree**

  ```bash
  test -f srv/lib/runtime-config/kg-settings.js && echo "#471 OK"
  test -f srv/jobs/secret-expiry-check.js && echo "#482 OK"
  test -f srv/lib/runtime-config/ui-events-settings.js && echo "#491 OK"
  grep -c 'entity Secrets' db/schema.cds
  grep -n '_withCsrf:' app/admin/secrets/webapp/controller/Secrets.controller.js
  ```

  Expected: 3× `OK`, `entity Secrets` count = 1, `_withCsrf:` found at line 178.

- [ ] **Step 0.3: Verify `db/audit-logging.cds` shape**

  ```bash
  grep -n '@AuditLog\.Operation\|@PersonalData\|Secrets' db/audit-logging.cds | head -10
  ```

  Expected: ZERO matches for `@AuditLog.Operation`, multiple `@PersonalData` rows for Users/UserMetaData/etc., zero matches for `Secrets` (#482 deliberately did not annotate it).

  This confirms: Phase 2-C is the first user of `@AuditLog.Operation` in this codebase. Task 4 below adds the first row.

- [ ] **Step 0.4: Confirm `@cap-js/audit-logging` is in dependencies**

  ```bash
  grep -n 'audit-logging' package.json
  ```

  Expected: at least one match (the plugin should be wired from earlier work). If MISSING, this becomes a prerequisite — flag it before continuing.

- [ ] **Step 0.5: Sanity-check tests pass on baseline**

  ```bash
  npx vitest run test/unit/jobs/secret-expiry-check.test.js 2>&1 | tail -10
  ```

  Expected: `7 passed (7)`. Establishes baseline; if this is red, fix env before adding more.

---

## Task 1: Add `jose` dependency

**Files:**

- Modify: `package.json` (deps section)

- [ ] **Step 1.1: Inspect current deps section**

  ```bash
  grep -A 30 '"dependencies"' package.json | head -35
  ```

  Note alphabetical ordering — `jose` lands between `@sap/*` aliases and `node-cron`.

- [ ] **Step 1.2: Add `jose` to dependencies**

  Add this line to the `"dependencies"` block (alphabetical order — between any `j*` deps; if none, between `@*` and the next letter):

  ```json
  "jose": "^5.10.0",
  ```

  Pin to `^5.x` per spec; `^5.10.0` is the latest stable as of plan-write date with no known breaking changes for our `compactDecrypt` + `importPKCS8` usage.

- [ ] **Step 1.3: Install + verify**

  ```bash
  npm install --ignore-scripts 2>&1 | tail -5
  test -d node_modules/jose && echo OK
  ```

  Expected: install succeeds, `node_modules/jose/` exists. Memory [[npm_security_config]]: project npmrc has `ignore-scripts=true`; the `--ignore-scripts` flag is belt-and-suspenders.

- [ ] **Step 1.4: Smoke import**

  ```bash
  node -e "import('jose').then(j => console.log('OK:', typeof j.compactDecrypt, typeof j.importPKCS8))"
  ```

  Expected: `OK: function function`. If either is `undefined`, `jose` v5 has shifted exports — pin to an earlier minor.

- [ ] **Step 1.5: Commit**

  ```bash
  git add package.json package-lock.json
  git commit -m "feat(deps): add jose ^5.x for BTP Credential Store JWE decrypt (#465)

  Single new dependency for Phase 2-C — used by srv/lib/credstore.js
  for compactDecrypt + importPKCS8(pem, 'RSA-OAEP-256'). De-facto
  Node JWE standard, used by every major OIDC implementation."
  ```

---

## Task 2: Add `tutorials-credstore` service binding (BOTH `mta.yaml` files + srv-qa cp chain)

**Files:**

- Modify: `mta.yaml` (root — local dev path)
- Modify: `.deploy/mta.yaml` (CI build path)

Both `mta.yaml` files MUST receive the same `tutorials-credstore` resource + binding edits. Additionally, `.deploy/mta.yaml`'s `srv-qa` module needs `credstore.js` appended to its hand-curated cp chain.

- [ ] **Step 2.1: Inspect both files' current shape**

  ```bash
  diff -q mta.yaml .deploy/mta.yaml   # Expect: "Files mta.yaml and .deploy/mta.yaml differ"
  grep -n 'name: tutorials-srv' mta.yaml
  grep -n 'name: tutorials-srv\|name: tutorials-srv-qa' .deploy/mta.yaml
  grep -n '^  - name:' mta.yaml | tail -5
  grep -n '^  - name:' .deploy/mta.yaml | tail -5
  ```

  Note line numbers of: `tutorials-srv`'s `requires:` block in BOTH files; end of `resources:` array in BOTH files; the `srv-qa` module's `build-parameters.commands` long line in `.deploy/mta.yaml` (around line 97).

- [ ] **Step 2.2: Add `tutorials-credstore` to `tutorials-srv` `requires:` in `mta.yaml` (root)**

  Use Edit. Anchor on `tutorials-srv` module's existing `requires:` list. Append:

  ```yaml
      - name: tutorials-credstore
  ```

  Match existing indentation (4 spaces under `requires:` under `modules:`).

- [ ] **Step 2.3: Add the `tutorials-credstore` resource definition to `mta.yaml` (root)**

  At the end of the `resources:` array, add:

  ```yaml
    - name: tutorials-credstore
      type: org.cloudfoundry.managed-service
      parameters:
        service: credstore
        service-plan: default
        config:
          authentication: basic
  ```

  Match existing indentation (2 spaces under `resources:`, 4 spaces for `parameters:`, 6 spaces for `config:`).

- [ ] **Step 2.4: Repeat 2.2 and 2.3 in `.deploy/mta.yaml`**

  Same edits, same YAML, same indentation. Also: if `.deploy/mta.yaml` has a `srv-qa` module with its own `requires:` list (it does — verified), append `- name: tutorials-credstore` to its requires list too. The QA channel needs the binding to boot.

- [ ] **Step 2.5: Add `credstore.js` to srv-qa cp chain in `.deploy/mta.yaml`** (BLOCKING — verified)

  Find the line in `.deploy/mta.yaml` that starts roughly:

  ```yaml
          - bash -c "mkdir -p srv/jobs && mkdir -p srv/handlers ... && cp ../../srv/lib/branch/...js srv/lib/branch/ && cp ../../srv/lib/runtime-config/...js srv/lib/runtime-config/ && cp ../../srv/lib/content-store.js ../../srv/lib/content-publish-session.js ../../srv/lib/_tutorials-table.js [...many more...] srv/lib/ && ..."
  ```

  This is one bash line in the `srv-qa` module's `build-parameters.commands` step (around line 97).

  In the `srv/lib/` cp segment (the `cp ../../srv/lib/content-store.js ../../srv/lib/content-publish-session.js ... srv/lib/` chain), add `../../srv/lib/credstore.js` to the list of source files. Position it near `content-store.js` or alphabetically — anywhere before the destination `srv/lib/` token works.

  Use Edit. The anchor is the literal substring `../../srv/lib/content-store.js` (unique on that long line). Insert `../../srv/lib/credstore.js` adjacent to it (with a space separator). Verification:

  ```bash
  grep -c "credstore\.js" .deploy/mta.yaml   # Expect: 1 (just the cp line we added)
  ```

- [ ] **Step 2.6: Check root `mta.yaml` for a same-shape srv-qa module**

  ```bash
  grep -n 'name: tutorials-srv-qa\|name: srv-qa' mta.yaml
  ```

  If root `mta.yaml` HAS a srv-qa module with a parallel hand-curated cp chain, repeat Step 2.5 on it. If root `mta.yaml` has no `srv-qa` module (the CI-only file is the canonical place for the QA channel), no edit needed — note this in the commit message.

- [ ] **Step 2.7: Validate YAML in both files**

  ```bash
  yq '.modules[] | select(.name == "tutorials-srv") | .requires' mta.yaml | head -10
  yq '.modules[] | select(.name == "tutorials-srv") | .requires' .deploy/mta.yaml | head -10
  yq '.resources[] | select(.name == "tutorials-credstore")' mta.yaml
  yq '.resources[] | select(.name == "tutorials-credstore")' .deploy/mta.yaml
  ```

  Expected: in BOTH files, requires lists include `tutorials-credstore`; both resource definitions emit identically.

  Cross-file diff sanity check (matching resource definitions):

  ```bash
  diff <(yq '.resources[] | select(.name == "tutorials-credstore")' mta.yaml) \
       <(yq '.resources[] | select(.name == "tutorials-credstore")' .deploy/mta.yaml)
  ```

  Expected: empty output (definitions match).

- [ ] **Step 2.8: Commit**

  ```bash
  git add mta.yaml .deploy/mta.yaml
  git commit -m "feat(deploy): bind tutorials-credstore BTP service (#465)

  Adds the tutorials-credstore managed-service resource + binding to BOTH
  mta.yaml files (CI uses .deploy/mta.yaml; local uses root mta.yaml).
  Default plan + basic auth → JWE-decryption with the binding's
  encryption.client_private_key. Per-environment instance.

  Also appends ../../srv/lib/credstore.js to the .deploy/mta.yaml srv-qa
  module's hand-curated cp chain — without this, the QA channel would
  crash on boot when admin-service.js tries to require('./lib/credstore').
  Memory feedback_srv_qa_cp_list_recurring has fired on this codebase
  multiple times.

  Entitlement confirmed available in tutorial-system subaccount
  (Tom verified 2026-06-20)."
  ```

---

## Task 3: Add `@AuditLog.Operation` annotation on `Secrets`

**Files:**

- Modify: `db/audit-logging.cds`

- [ ] **Step 3.1: Read current audit-logging.cds structure**

  ```bash
  cat db/audit-logging.cds | head -50
  ```

  Confirm:
  - File starts with `using ... from '@cap-js/audit-logging';` or similar import.
  - Existing annotations use `@PersonalData` form on Users / UserMetaData / TaskRecords / etc.
  - No existing `@AuditLog.Operation` annotation anywhere.

- [ ] **Step 3.2: Append `@AuditLog.Operation` annotation on Secrets**

  Use Edit. Anchor on the LAST `annotate ims.<EntityName> with @PersonalData...` block in the file (the file is structured as a sequence of annotate-blocks). After the closing `};` of that last block, append:

  ```cds

  // Phase 2-C (#465): security-purpose audit on Secrets metadata writes.
  // @PersonalData is intentionally NOT set — secret values aren't personal
  // data per GDPR semantics. @AuditLog.Operation is the security-purpose
  // annotation that triggers @cap-js/audit-logging plugin events on CRUD
  // mutations. Custom OData V4 actions/functions (setSecretValue,
  // rotateSecretValue, revealSecretValue, clearSecretValue) do NOT fire
  // these CRUD interceptors — their handlers in srv/admin-service.js call
  // cds.audit.log() explicitly. This annotation captures metadata-edits
  // via the standard projection (description, expiresAt, rotationOwner
  // changes via the admin tile's metadata editor).
  annotate ims.Secrets with @AuditLog.Operation: {
    Read   : true,
    Insert : true,
    Update : true,
    Delete : true,
  };
  ```

- [ ] **Step 3.3: Verify CDS compiles**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. If the `@AuditLog.Operation` syntax fails to parse, cross-reference against the `@cap-js/audit-logging` plugin's README in `node_modules/@cap-js/audit-logging/README.md` for the exact annotation form (the spec uses the documented shape; small variations like `Operations` vs `Operation` are plugin-version dependent).

- [ ] **Step 3.4: Commit**

  ```bash
  git add db/audit-logging.cds
  git commit -m "feat(audit-log): @AuditLog.Operation on Secrets (#465)

  Security-purpose annotation (NOT @PersonalData — secret values
  aren't personal data per GDPR). Captures CRUD events on Secrets
  metadata edits. Custom OData V4 actions for value mutation
  (setSecretValue etc.) fire cds.audit.log() explicitly in their
  handlers (Task 6) — CRUD interceptors only catch standard
  projection CRUD, not bound actions/functions."
  ```

---

## Task 4: Create credstore lib (`srv/lib/credstore.js`)

**Files:**

- Create: `srv/lib/credstore.js`

This is the single chokepoint for all BTP Credential Store I/O. ~140 lines. Uses `globalThis`-keyed cache per the [[feedback_module_singletons_in_vitest_cds]] memory (fired 4× already in this codebase; this is preemption).

- [ ] **Step 4.1: Create the file with the full content**

  Write to `srv/lib/credstore.js`:

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
  // [feedback_module_singletons_in_vitest_cds] has fired 4× already — preempting here.
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
    // the credstore service's JWE algorithm (SAP-published). Algorithm pin
    // defends against algorithm-confusion if the service ever returns a
    // different alg header.
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
   *  present. JSON.stringify on the body handles values containing quotes,
   *  newlines, Unicode natively. Returns true on success. */
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

  /** Delete a secret by alias. Returns true on success OR 404 (idempotent). */
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

- [ ] **Step 4.2: Syntax check**

  ```bash
  node --check srv/lib/credstore.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 4.3: Smoke import (no binding present, so just check it loads)**

  ```bash
  node -e "import('./srv/lib/credstore.js').then(m => console.log('exports:', Object.keys(m).join(',')))"
  ```

  Expected: `exports: readSecret,writeSecret,deleteSecret,_resetForTests`.

- [ ] **Step 4.4: Commit**

  ```bash
  git add srv/lib/credstore.js
  git commit -m "feat(credstore): BTP Credential Store integration lib (#465)

  Single chokepoint for all credstore I/O. readSecret / writeSecret /
  deleteSecret. JWE decrypt via jose.compactDecrypt with RSA-OAEP-256
  algorithm pin (defense against algorithm-confusion).

  globalThis-keyed cache (Symbol.for) matches the post-#491 runtime-
  config resolver pattern — preempts the module-singleton multiplicity
  bug that [feedback_module_singletons_in_vitest_cds] has caught 4×.

  Idempotent delete (404 → true). No retry logic: credential failures
  surface to caller (a 'failed' write may actually have succeeded;
  retry could create duplicates)."
  ```

---

## Task 5: Add 3 actions + 1 function to AdminService (`srv/admin-service.cds`)

**Files:**

- Modify: `srv/admin-service.cds`

- [ ] **Step 5.1: Locate the existing `Secrets` projection**

  ```bash
  grep -n 'entity Secrets as projection\|function secretWarnings' srv/admin-service.cds
  ```

  Note the line of `entity Secrets as projection on ims.Secrets` (a one-liner from #482).

- [ ] **Step 5.2: Replace with actions-augmented form**

  Use Edit. Anchor on the entire one-liner. Replace with:

  ```cds
  @requires: 'Admin'
  entity Secrets as projection on ims.Secrets actions {

    // Phase 2-C (#465): Set a secret's value in BTP Credential Store.
    // Overwrites if value already exists. Stamps lastRotatedAt as a
    // side-effect (admins see immediate feedback in the tile).
    action setSecretValue(value: String) returns {
      written : Boolean;
      lastRotatedAt : Timestamp;
    };

    // Phase 2-C (#465): Generate a fresh value AND write it. For self-gen
    // kinds (salt, content-api-key), mints 32 bytes hex via crypto.randomBytes.
    // For vendor-side kinds (github-pat, service-key, smtp-credential, other),
    // returns structured guidance instead of throwing — tile renders a
    // friendly dialog with the rotationDocsUrl link.
    action rotateSecretValue() returns {
      rotated : Boolean;
      reason : String;          // 'self-generated' | 'vendor-side'
      newValue : String;        // populated only when rotated=true
      written : Boolean;        // populated only when rotated=true
      lastRotatedAt : Timestamp;
      revealExpiresAt : Timestamp;
      rotationDocsUrl : String; // populated when rotated=false (echoed from row)
    };

    // Phase 2-C (#465): Delete the credstore entry. Keeps the HANA metadata
    // row. Idempotent — clearing a non-existent value is a no-op.
    action clearSecretValue() returns {
      cleared : Boolean;
    };

    // Phase 2-C (#465): Reveal the current secret value for short-lived
    // display in the admin tile. Returns plaintext + server-supplied
    // expiresAt (~30s). Each invocation emits a SecretValueRead audit-log
    // event via explicit cds.audit.log() call in the handler (custom OData
    // functions don't fire CRUD interceptors).
    function revealSecretValue() returns {
      value : String;
      expiresAt : Timestamp;
    };
  };
  ```

  **Note:** `@requires: 'Admin'` covers the entity AND all 4 actions/function (bound operations inherit `@requires` from their parent entity in OData V4).

- [ ] **Step 5.3: Verify CDS compiles**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null && echo OK
  ```

  Expected: `OK`. If compile fails, check the closing `};` after the actions block.

- [ ] **Step 5.4: Smoke-test EDMX exposes the operations** (IMPORTANT 11)

  Regenerate the OData V4 EDMX and confirm the 4 new operations appear. Without EDMX regeneration, the Fiori UI controller's `$metadata` HEAD won't see the new actions and FE's `$$inheritExpandSelect` / action-binding will fail at runtime:

  ```bash
  npx cds compile srv/admin-service.cds --to edmx-v4 > /tmp/admin.edmx 2>&1
  grep -c -E 'setSecretValue|rotateSecretValue|clearSecretValue|revealSecretValue' /tmp/admin.edmx
  ```

  Expected: count ≥ 4 (each operation appears at least once — possibly multiple times if FunctionImport / ActionImport blocks emit separately).

  Also verify the binding parameter targets `AdminService.Secrets`:

  ```bash
  grep -E '<Action |<Function ' /tmp/admin.edmx | grep -iE 'secret' | head -8
  ```

  Expected: 4 entries (3 Action + 1 Function). Each should have an inner `<Parameter Name="_it" Type="AdminService.Secrets"/>` (or equivalent) marking it instance-bound.

  If the project has a `cds build` step that emits EDMX into a known output path (check `package.json` `scripts.build`), run that too:

  ```bash
  grep -E '"build"|"cds:build"' package.json
  # If present, e.g.: npm run build  →  produces gen/srv/ with edmx files
  ```

- [ ] **Step 5.5: Commit**

  ```bash
  git add srv/admin-service.cds
  git commit -m "feat(admin): 3 actions + 1 function on Secrets (#465)

  setSecretValue: write to credstore + stamp lastRotatedAt.
  rotateSecretValue: discriminated union — self-gen kinds mint
    32B hex; vendor-side kinds return rotated:false + rotationDocsUrl.
  clearSecretValue: delete credstore entry; idempotent.
  revealSecretValue: function (GET, no CSRF) returns plaintext +
    server-supplied 30s expiresAt; tile auto-hides on expiry.

  All bound to Secrets; inherit @requires:'Admin' from entity."
  ```

---

## Task 6: Add 4 handlers to admin-service.js

**Files:**

- Modify: `srv/admin-service.js` (insert after existing `secretWarnings` handler at line ~990)

This task adds 4 handlers + 3 helpers (loadSecretRow, stampRotated, auditEvent) + 1 response-header helper (setNoStoreHeaders). ~140 lines. Each handler emits explicit audit events via the `auditEvent()` helper (which uses `cds.connect.to('audit-log')` + `.log(name, { data })` per verified codebase patterns) where the standard CRUD interceptor wouldn't fire.

- [ ] **Step 6.1: Locate insertion point**

  ```bash
  grep -n 'this.on..secretWarnings' srv/admin-service.js
  ```

  Then read from that line forward to find the matching `});` that closes the handler:

  ```bash
  awk '/this\.on..secretWarnings/,/^    \}\);/' srv/admin-service.js | tail -5
  ```

- [ ] **Step 6.2: Add imports at top of file**

  Find the existing imports block. Add:

  ```javascript
  import { readSecret, writeSecret, deleteSecret } from './lib/credstore.js';
  import { randomBytes } from 'node:crypto';
  ```

  Use Edit. Anchor on an existing `import` line (e.g. the one importing from `./jobs/secret-expiry-check.js` from #482).

- [ ] **Step 6.3: Insert handlers after `secretWarnings`**

  Use Edit. Anchor on the closing `});` of the `secretWarnings` handler. Insert AFTER it:

  ```javascript

      // ──────────────────────────────────────────────────────────────────────
      // Phase 2-C (#465): Secret value operations via BTP Credential Store.
      // Helpers + 4 handlers (3 actions + 1 function on Secrets).
      // ──────────────────────────────────────────────────────────────────────

      // ~30 second reveal window. Server-supplied; tile auto-hides on this expiry.
      const REVEAL_WINDOW_MS = 30_000;

      // Self-generate-able kinds — admin clicks Rotate, server mints + writes.
      const SELF_GEN_KINDS = new Set(['salt', 'content-api-key']);

      // Load the Secrets row by bound-action ID. All 4 handlers need this.
      // IMPORTANT 7: defensive guard against missing req.params shape (e.g. if
      // an action ever ends up wrongly bound to collection rather than instance,
      // req.params is []).
      const loadSecretRow = async (req) => {
        const { Secrets } = cds.entities('com.sap.developers.ims');
        const id = req.params?.[0]?.ID;
        if (!id) return req.reject(400, 'Secret ID required (bound to instance, not collection)');
        const row = await SELECT.one.from(Secrets).where({ ID: id });
        if (!row) req.reject(404, 'Secret not found');
        return row;
      };

      // Stamp lastRotatedAt on the row.
      const stampRotated = async (id) => {
        const { Secrets } = cds.entities('com.sap.developers.ims');
        const ts = new Date();
        await UPDATE(Secrets).set({ lastRotatedAt: ts }).where({ ID: id });
        return ts;
      };

      // BLOCKING 1: audit-log helper. Verified against existing usage at
      // srv/admin-service.js:1072-1073 (canonical pattern: cds.connect.to('audit-log')
      // + audit.log(eventName, { data: {...} })) and the graceful-degradation
      // pattern at srv/knowledge-graph-service.js:395-401 (catch missing binding).
      //
      // cds.audit?.log?.(...) does NOT exist — optional-chaining would mean
      // audit events silently never fire. Use this helper everywhere instead.
      const auditEvent = async (eventName, data) => {
        const audit = await cds.connect.to('audit-log').catch(() => null);
        if (audit) {
          await audit.log(eventName, { data });
        }
      };

      // IMPORTANT 8: response-header helper using public API. req._.res is CAP
      // internal and not guaranteed stable across minor versions. Prefer req.req.res
      // (the Express req has .res back-ref), fall back to req._.res, and silently
      // no-op if neither resolves. Action's return value carries the actual data
      // either way; the header is defense-in-depth.
      const setNoStoreHeaders = (req) => {
        const res = req.req?.res ?? req._?.res;
        if (res?.setHeader) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
          res.setHeader('Pragma', 'no-cache');
        }
      };

      // ────────────────────────────────────────────────────────────────────
      this.on('setSecretValue', 'Secrets', async (req) => {
        const row = await loadSecretRow(req);
        const { value } = req.data;
        if (!value || typeof value !== 'string') {
          return req.reject(400, 'value (non-empty string) is required');
        }
        await writeSecret(row.key, value);
        const lastRotatedAt = await stampRotated(row.ID);
        // CRUD interceptor on Secrets fires for the UPDATE on lastRotatedAt
        // → captured by @AuditLog.Operation; no explicit audit event needed here.
        return { written: true, lastRotatedAt };
      });

      // ────────────────────────────────────────────────────────────────────
      this.on('rotateSecretValue', 'Secrets', async (req) => {
        const row = await loadSecretRow(req);
        if (!SELF_GEN_KINDS.has(row.kind)) {
          // Vendor-side: emit audit event (no value mutation occurred but the
          // user attempted a rotation, worth logging).
          await auditEvent('SecretValueRotateAttempted', {
            user: req.user?.id,
            secretKey: row.key,
            rotated: false,
          });
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
        // 32 bytes hex = 64-char string. Strong enough for salt + api-key.
        const newValue = randomBytes(32).toString('hex');
        await writeSecret(row.key, newValue);
        const lastRotatedAt = await stampRotated(row.ID);
        const revealExpiresAt = new Date(Date.now() + REVEAL_WINDOW_MS);
        // Custom action emitting plaintext — explicit audit event needed.
        await auditEvent('SecretValueRotated', {
          user: req.user?.id,
          secretKey: row.key,
          rotated: true,
        });
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

      // ────────────────────────────────────────────────────────────────────
      this.on('clearSecretValue', 'Secrets', async (req) => {
        const row = await loadSecretRow(req);
        await deleteSecret(row.key);
        // No HANA mutation; explicit audit event needed.
        await auditEvent('SecretValueCleared', {
          user: req.user?.id,
          secretKey: row.key,
        });
        return { cleared: true };
      });

      // ────────────────────────────────────────────────────────────────────
      this.on('revealSecretValue', 'Secrets', async (req) => {
        const row = await loadSecretRow(req);
        const value = await readSecret(row.key);
        if (value == null) return req.reject(404, 'No value stored for this secret');

        // Defense-in-depth: don't let proxies cache the response, even though
        // /admin/* is XSUAA-gated. `private` for shared-cache defense.
        // Best-effort: action's return value carries the data regardless.
        setNoStoreHeaders(req);

        // Function (read-only OData) — explicit audit event needed.
        // The value is NOT logged; only the access event.
        await auditEvent('SecretValueRead', {
          user: req.user?.id,
          secretKey: row.key,
        });

        return {
          value,
          expiresAt: new Date(Date.now() + REVEAL_WINDOW_MS),
        };
      });
  ```

  **BLOCKING 1 note (verified against codebase 2026-06-21):** Existing pattern at `srv/admin-service.js:1072-1073` uses:

  ```javascript
  const audit = await cds.connect.to('audit-log');
  await audit.log('SecurityEvent', { /* data */ });
  ```

  Graceful-degradation pattern at `srv/knowledge-graph-service.js:395-401` wraps the connect in `try/catch` so missing-binding contexts (unit tests) don't break the handler. The `auditEvent()` helper above combines both. **`cds.audit?.log?.()` does NOT exist as an API** — optional chaining there means audit events would silently never fire.

  **IMPORTANT 8 note:** `req._.res.setHeader` is CAP internal API and may change between minor versions. The `setNoStoreHeaders` helper above prefers `req.req?.res` (the Express request's `.res` back-reference, public) and falls back to `req._.res` only if needed. Best-effort: if header-setting fails entirely the action still returns the value, the cache header was defense-in-depth only.

- [ ] **Step 6.4: Syntax check**

  ```bash
  node --check srv/admin-service.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 6.5: Verify audit-log API pattern usage** (BLOCKING 1)

  ```bash
  grep -n "cds.connect.to('audit-log')" srv/admin-service.js | head -5
  grep -n "cds\.audit\?" srv/admin-service.js   # Should return 0 matches — that API does NOT exist
  ```

  Expected: at least one match for `cds.connect.to('audit-log')` (the `auditEvent` helper added in 6.3); zero matches for `cds.audit?`. If `cds.audit?` matches anywhere, the optional-chaining-as-API-feature mistake has slipped in — fix to use the `auditEvent` helper.

  Cross-reference the canonical existing pattern:

  ```bash
  grep -n -B1 -A2 "cds\.connect\.to('audit-log')" srv/admin-service.js srv/knowledge-graph-service.js
  ```

  Expected: matches at admin-service.js:1072 (existing SecurityEvent call) and knowledge-graph-service.js:395-401 (existing graceful-degradation pattern).

- [ ] **Step 6.6: Smoke boot to verify handlers register**

  ```bash
  timeout 15 npx cds run --in-memory 2>&1 | grep -E 'setSecretValue|rotateSecretValue|clearSecretValue|revealSecretValue|ERROR' | head -10 || true
  ```

  Expected: the 4 operation names appear in the route table (or the server boots without errors and you can curl `/admin/$metadata` to verify).

- [ ] **Step 6.7: Commit**

  ```bash
  git add srv/admin-service.js
  git commit -m "feat(admin): 4 handlers for Secrets value operations (#465)

  setSecretValue / rotateSecretValue / clearSecretValue handlers
  fire @AuditLog.Operation CRUD interceptor via stampRotated()
  UPDATE on Secrets. revealSecretValue + the value-emit paths
  emit explicit audit events via auditEvent() helper (custom OData
  V4 actions/functions don't trigger CRUD interceptors).

  auditEvent() uses cds.connect.to('audit-log') wrapped in catch(()=>null)
  per existing patterns at srv/admin-service.js:1072 + knowledge-graph-
  service.js:395-401. The cds.audit?.log?.() shape from earlier drafts
  was wrong — that API does NOT exist; optional chaining there means
  audit events silently never fire.

  revealSecretValue handler sets Cache-Control: no-store, no-cache,
  must-revalidate, private via setNoStoreHeaders helper (prefers
  public req.req.res, falls back to req._.res for older CAP versions,
  no-ops if neither resolves — best-effort defense-in-depth)."
  ```

---

## Task 7: Unit tests for credstore lib

**Files:**

- Create: `test/unit/lib/credstore.test.js`

6 tests. Mocks native `fetch` via `vi.stubGlobal`. JWE round-trip test uses a fixture key + JWE blob generated once via a setup snippet.

- [ ] **Step 7.1: Generate the JWE fixture** (one-time, locally — keep in test file as inline constants)

  Run this Node script ONCE to generate fixtures. Capture stdout and paste the strings into the test file:

  ```bash
  node -e "
  import('jose').then(async (j) => {
    const { generateKeyPair, exportPKCS8, exportSPKI, CompactEncrypt, importSPKI } = j;
    const { publicKey, privateKey } = await generateKeyPair('RSA-OAEP-256', { modulusLength: 2048 });
    const pem = await exportPKCS8(privateKey);
    const pub = await importSPKI(await exportSPKI(publicKey), 'RSA-OAEP-256');
    const plaintext = new TextEncoder().encode(JSON.stringify({ value: 'test-secret-value' }));
    const jwe = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
      .encrypt(pub);
    console.log('---PRIVATE-PEM---');
    console.log(pem);
    console.log('---JWE-BLOB---');
    console.log(jwe);
  });
  "
  ```

  Save the output. The PEM goes into a const at the top of the test file; the JWE blob into another const. (~50 chars wrapped at 80 in PEM; JWE is ~340 chars one line.)

- [ ] **Step 7.2: Create the test file**

  Write to `test/unit/lib/credstore.test.js`:

  ```javascript
  // test/unit/lib/credstore.test.js
  // Phase 2-C (#465). 6 tests covering BTP Credential Store integration lib.

  import { describe, it, expect, beforeEach, vi } from 'vitest';

  // Set fake binding BEFORE importing credstore — xsenv reads VCAP_SERVICES
  // at require time (well, on first getServices() call, so this is fine).
  process.env.VCAP_SERVICES = JSON.stringify({
    credstore: [{
      tags: ['credstore'],
      credentials: {
        url: 'https://credstore.example.com',
        username: 'testuser',
        password: 'testpass',
        encryption: {
          // Paste the PRIVATE-PEM output from Step 7.1 here.
          // For brevity in the plan, marked as a placeholder — implementer
          // generates this in Step 7.1 and substitutes.
          client_private_key: `<<<PASTE-PEM-HERE>>>`,
        },
      },
    }],
  });

  // JWE blob containing {"value":"test-secret-value"} encrypted with the
  // public key matching the PEM above. Implementer pastes from Step 7.1.
  const FIXTURE_JWE = `<<<PASTE-JWE-HERE>>>`;

  // Import AFTER setting VCAP_SERVICES.
  const { readSecret, writeSecret, deleteSecret, _resetForTests } =
    await import('../../../srv/lib/credstore.js');

  beforeEach(() => {
    _resetForTests();
    vi.unstubAllGlobals();
  });

  describe('readSecret (#465)', () => {
    it('returns null on 404 (entry doesn\'t exist)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 404, ok: false, text: () => Promise.resolve(''),
      }));
      const result = await readSecret('MISSING_KEY');
      expect(result).toBeNull();
    });

    it('throws on non-200/404 (network error, auth failure)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 401, ok: false, text: () => Promise.resolve('unauthorized'),
      }));
      await expect(readSecret('SOMEKEY')).rejects.toThrow(/credstore read SOMEKEY: 401/);
    });

    it('JWE-decrypt round-trip with fixture private key + JWE blob', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200, ok: true,
        text: () => Promise.resolve(FIXTURE_JWE),
      }));
      const result = await readSecret('TEST_KEY');
      expect(result).toBe('test-secret-value');
    });
  });

  describe('writeSecret (#465)', () => {
    it('POSTs to /password with namespace + Basic auth headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal('fetch', fetchMock);
      await writeSecret('TEST_KEY', 'new-value');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://credstore.example.com/password');
      expect(opts.method).toBe('POST');
      expect(opts.headers['sapcp-credstore-namespace']).toBe('tutorials');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      expect(JSON.parse(opts.body)).toEqual({ name: 'TEST_KEY', value: 'new-value' });
    });
  });

  describe('deleteSecret (#465)', () => {
    it('returns true on 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
      expect(await deleteSecret('TEST_KEY')).toBe(true);
    });

    it('returns true on 404 (idempotent)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 404, ok: false, text: () => Promise.resolve(''),
      }));
      expect(await deleteSecret('MISSING_KEY')).toBe(true);
    });
  });
  ```

- [ ] **Step 7.3: Create directory + paste fixtures**

  ```bash
  mkdir -p test/unit/lib
  ```

  Then paste the test file with `<<<PASTE-PEM-HERE>>>` and `<<<PASTE-JWE-HERE>>>` replaced by the actual values from Step 7.1.

- [ ] **Step 7.4: Run the tests**

  ```bash
  npx vitest run test/unit/lib/credstore.test.js 2>&1 | tail -15
  ```

  Expected: `6 passed (6)`. If the JWE-decrypt test fails with "algorithm mismatch," double-check Step 7.1's `setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })` matched and `importPKCS8(pem, 'RSA-OAEP-256')` in the lib matches.

- [ ] **Step 7.5: Commit**

  ```bash
  git add test/unit/lib/credstore.test.js
  git commit -m "test(unit): credstore lib coverage (#465)

  6 tests: 404→null, non-200/404→throw, JWE round-trip with fixture
  key, write headers + namespace + Basic auth, idempotent delete (200
  and 404). Fixture private key + JWE blob generated once via inline
  script in Step 7.1; pasted as constants."
  ```

---

## Task 8: Unit tests for the 4 admin handlers

**Files:**

- Create: `test/unit/admin-secret-value-handlers.test.js`

8 tests. Mocks `srv/lib/credstore.js` via `vi.spyOn` (same pattern as #491's `rebuild-trigger.test.js`).

**BLOCKING 2 note (verified against codebase 2026-06-21):** Bootstrap pattern at `test/unit/author-service.test.js:1-5` uses `cds.test('serve', '--project', '.', '--in-memory')` at **module top level** (NOT inside `beforeAll`), which auto-deploys schema + serves the OData runtime. Bound-action invocation is `srv.tx({ user }, tx => tx.send({ event, entity, params, data }))` — NOT the invented `callBoundAction({ query: { kind, target, action } })` shape from earlier drafts.

- [ ] **Step 8.1: Inspect a sibling handler-test for bootstrap pattern**

  ```bash
  head -10 test/unit/author-service.test.js
  grep -n "cds.test\|srv.tx\|tx.send" test/unit/*.test.js | head -20
  ```

  Note the canonical bootstrap shape:

  ```javascript
  import { describe, it, expect, beforeAll } from 'vitest';
  import cds from '@sap/cds';

  const project = cds.test('serve', '--project', '.', '--in-memory');
  ```

  And bound-action call shapes (from grepping the unit-test directory):

  ```javascript
  // Simple action with positional args:
  return srv.tx({ user }, (tx) => tx.send('reviewTutorial', { tutorialId: 't-1' }));

  // Action with explicit event/entity shape (use this when binding to an
  // instance with parameters):
  return srv.tx({ user }, tx => tx.send({ event, entity: 'AdminService.Secrets', params: [{ ID }], data }));
  ```

- [ ] **Step 8.2: Write the test file**

  Write to `test/unit/admin-secret-value-handlers.test.js`:

  ```javascript
  // test/unit/admin-secret-value-handlers.test.js
  // Phase 2-C (#465). 8 tests for the 4 OData handlers on Secrets.

  import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
  import cds from '@sap/cds';
  import * as credstore from '../../srv/lib/credstore.js';

  // BLOCKING 2 (verified against test/unit/author-service.test.js): module-top
  // cds.test('serve', ...) auto-deploys schema + serves the OData runtime.
  // Do NOT replace with cds.deploy(...).to('sqlite::memory:') inside beforeAll
  // — that was the wrong-shape pattern from earlier plan drafts.
  const project = cds.test('serve', '--project', '.', '--in-memory');

  // IMPORTANT 10: @sap/xsenv mock. The credstore lib calls
  // getServices({ credstore: { tag: 'credstore' } }) — without a real
  // binding (no VCAP_SERVICES set in tests) this would throw at first
  // call. Mock with the exact shape the lib reads (.url, .username,
  // .password, .encryption.client_private_key). Note: the credstore
  // tests in Task 7 set VCAP_SERVICES via process.env instead — pick
  // the strategy that matches the test file. Here we use vi.mock
  // because we're spying on the credstore lib (writeSecret etc.) and
  // never actually exercise the binding lookup.
  vi.mock('@sap/xsenv', () => ({
    getServices: vi.fn(() => ({
      credstore: {
        url: 'https://mock-credstore.test',
        username: 'mock-user',
        password: 'mock-pass',
        encryption: {
          client_private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
        },
      },
    })),
    loadEnv: vi.fn(),
  }));

  const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

  beforeEach(async () => {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Secrets);
    vi.restoreAllMocks();
  });

  async function seedSecret({ key, kind = 'salt', rotationDocsUrl = '' } = {}) {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await INSERT.into(Secrets).entries({
      ID, key, kind, rotationDocsUrl,
      description: `test ${key}`,
    });
    return { ID, key, kind };
  }

  // Helper: invoke a bound action. Wraps the verified `tx.send({ event,
  // entity, params, data })` pattern (the canonical CAP V4 shape — see
  // BLOCKING 2 ground-truth in plan-review notes).
  async function callAction(eventName, secretId, data = {}) {
    const srv = await cds.connect.to('AdminService');
    return srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.send({ event: eventName, entity: 'AdminService.Secrets', params: [{ ID: secretId }], data })
    );
  }

  describe('setSecretValue (#465)', () => {
    it('happy-path: writes credstore + stamps lastRotatedAt', async () => {
      const writeSpy = vi.spyOn(credstore, 'writeSecret').mockResolvedValue(true);
      const { ID, key } = await seedSecret({ key: 'TEST_SET_OK' });
      const result = await callAction('setSecretValue', ID, { value: 'newval' });
      expect(result.written).toBe(true);
      expect(result.lastRotatedAt).toBeTruthy();
      expect(writeSpy).toHaveBeenCalledWith('TEST_SET_OK', 'newval');
    });

    it('rejects empty value with 400', async () => {
      const { ID } = await seedSecret({ key: 'TEST_SET_REJECT' });
      await expect(callAction('setSecretValue', ID, { value: '' }))
        .rejects.toMatchObject({ code: 400 });
    });
  });

  describe('rotateSecretValue (#465)', () => {
    it('self-gen kind (salt): mints 64-char hex + writes', async () => {
      const writeSpy = vi.spyOn(credstore, 'writeSecret').mockResolvedValue(true);
      const { ID } = await seedSecret({ key: 'TEST_ROT_SALT', kind: 'salt' });
      const result = await callAction('rotateSecretValue', ID);
      expect(result.rotated).toBe(true);
      expect(result.reason).toBe('self-generated');
      expect(result.newValue).toMatch(/^[0-9a-f]{64}$/);
      expect(writeSpy).toHaveBeenCalled();
    });

    it('self-gen kind (content-api-key): same shape', async () => {
      vi.spyOn(credstore, 'writeSecret').mockResolvedValue(true);
      const { ID } = await seedSecret({ key: 'TEST_ROT_API', kind: 'content-api-key' });
      const result = await callAction('rotateSecretValue', ID);
      expect(result.rotated).toBe(true);
      expect(result.newValue).toMatch(/^[0-9a-f]{64}$/);
    });

    it('vendor-side kind (github-pat): returns rotated:false + rotationDocsUrl', async () => {
      const writeSpy = vi.spyOn(credstore, 'writeSecret').mockResolvedValue(true);
      const { ID } = await seedSecret({
        key: 'TEST_ROT_GH', kind: 'github-pat',
        rotationDocsUrl: 'https://docs.example.com/rotate',
      });
      const result = await callAction('rotateSecretValue', ID);
      expect(result.rotated).toBe(false);
      expect(result.reason).toBe('vendor-side');
      expect(result.rotationDocsUrl).toBe('https://docs.example.com/rotate');
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('clearSecretValue (#465)', () => {
    it('happy-path: deletes credstore entry', async () => {
      const deleteSpy = vi.spyOn(credstore, 'deleteSecret').mockResolvedValue(true);
      const { ID, key } = await seedSecret({ key: 'TEST_CLEAR' });
      const result = await callAction('clearSecretValue', ID);
      expect(result.cleared).toBe(true);
      expect(deleteSpy).toHaveBeenCalledWith(key);
    });
  });

  describe('revealSecretValue (#465)', () => {
    it('happy-path: returns value + expiresAt ~30s ahead', async () => {
      vi.spyOn(credstore, 'readSecret').mockResolvedValue('secret-plaintext');
      const { ID } = await seedSecret({ key: 'TEST_REVEAL' });
      const result = await callAction('revealSecretValue', ID);
      expect(result.value).toBe('secret-plaintext');
      const delta = new Date(result.expiresAt).getTime() - Date.now();
      expect(delta).toBeGreaterThan(25_000);
      expect(delta).toBeLessThanOrEqual(30_000);
    });

    it('when no value stored: rejects with 404', async () => {
      vi.spyOn(credstore, 'readSecret').mockResolvedValue(null);
      const { ID } = await seedSecret({ key: 'TEST_NO_VAL' });
      await expect(callAction('revealSecretValue', ID))
        .rejects.toMatchObject({ code: 404 });
    });
  });
  ```

- [ ] **Step 8.3: Run the tests**

  ```bash
  npx vitest run test/unit/admin-secret-value-handlers.test.js 2>&1 | tail -20
  ```

  Expected: `8 passed (8)`. If the test fails with "service not found" or "action not registered", verify the `cds.test('serve', ...)` line is at MODULE TOP (not inside beforeAll) — CAP's test harness reads `package.json`'s `cds.requires` block at module load time.

  If `tx.send({ event, entity, params, data })` is rejected with a shape error, fall back to the simpler `tx.send(eventName, data)` form and target the entity by ID via `data.ID` (CAP versions differ on this signature). Cross-check against the canonical example at `test/unit/author-service.test.js`.

- [ ] **Step 8.4: Commit**

  ```bash
  git add test/unit/admin-secret-value-handlers.test.js
  git commit -m "test(unit): 4 handler coverage for Secrets value operations (#465)

  8 tests: setSecretValue happy + 400-on-empty; rotateSecretValue
  self-gen × 2 (salt, content-api-key) + vendor-side (github-pat);
  clearSecretValue happy; revealSecretValue happy (with expiresAt
  range check) + 404-on-no-value. Credstore lib mocked via vi.spyOn
  (same pattern as #491 rebuild-trigger tests).

  Bootstrap uses cds.test('serve', '--project', '.', '--in-memory') at
  module top (verified canonical pattern from test/unit/author-service.
  test.js:1-5). Bound actions invoked via srv.tx + tx.send({ event,
  entity, params, data }) — NOT the wrong-shape callBoundAction
  ({ query: { kind, target, action } }) from earlier draft.

  @sap/xsenv mocked with vi.mock so the credstore lib's getServices
  call resolves a fake binding (we vi.spyOn the lib's exported
  read/write/deleteSecret functions, so the binding lookup never
  actually fires)."
  ```

---

## Task 9: Add "Secret Value" Panel to admin tile (`view/SecretDialog.fragment.xml`)

**Files:**

- Modify: `app/admin/secrets/webapp/view/SecretDialog.fragment.xml`

- [ ] **Step 9.1: Inspect current dialog structure**

  ```bash
  cat app/admin/secrets/webapp/view/SecretDialog.fragment.xml
  ```

  **BLOCKING 5 (verified against codebase 2026-06-21):** the actual fragment shape is:

  ```xml
  <core:FragmentDefinition ...>
    <Dialog ...>
      <f:SimpleForm editable="true" layout="ResponsiveGridLayout">
        <Label .../>
        <Input .../>
        ... 14 lines of field pairs ...
      </f:SimpleForm>
      <buttons>
        <Button text="{i18n>buttonSave}" type="Emphasized" press=".onDialogSave" />
        <Button text="{i18n>buttonCancel}" press=".onDialogCancel" />
      </buttons>
    </Dialog>
  </core:FragmentDefinition>
  ```

  The new "Secret value" Panel MUST be inserted as a **sibling of `<f:SimpleForm>`** (i.e. direct child of `<Dialog>`), positioned **between `</f:SimpleForm>` and `<buttons>`**. Do NOT place it inside `<f:SimpleForm>` — that container uses a strict Label/Input pair layout in ResponsiveGridLayout, and a nested Panel breaks the form grid.

- [ ] **Step 9.2: Add the Panel — TIGHT ANCHOR** (BLOCKING 5)

  Use Edit with a literal two-line anchor. Find this EXACT pair of consecutive lines in the file:

  ```xml
      </f:SimpleForm>
      <buttons>
  ```

  Replace with:

  ```xml
      </f:SimpleForm>

      <Panel headerText="{i18n>panelSecretValue}" expandable="true" expanded="false" class="sapUiSmallMarginTop">

        <!-- Reveal area: hidden by default. When user clicks "Show Value",
             fetch revealSecretValue() and populate. Auto-hide on revealExpiresAt. -->
        <VBox visible="{= !!${dialog>/revealedValue}}" class="sapUiSmallMarginBottom">
          <MessageStrip
            text="{= 'Value visible for ' + ${dialog>/revealSecondsLeft} + 's. Logged in audit trail.' }"
            type="Warning"
            showIcon="true" />
          <Input
            value="{dialog>/revealedValue}"
            editable="false"
            class="sapUiSmallMarginTop" />
        </VBox>

        <!-- Action buttons. Disabled until metadata is saved (no ID to bind). -->
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

      <buttons>
  ```

  Indent to match the surrounding XML (use 4-space indent on the Panel's outer attribute lines if the file uses 4-space; use 2-space if it does).

  Verification — the Panel must be a sibling of SimpleForm, NOT nested inside:

  ```bash
  grep -n -B1 -A1 "<Panel" app/admin/secrets/webapp/view/SecretDialog.fragment.xml
  ```

  Expected: the line BEFORE `<Panel` is the closing `</f:SimpleForm>` (with a blank line between is fine); the line AFTER the `</Panel>` close is the opening `<buttons>` tag (blank line between is fine).

- [ ] **Step 9.3: Run UI5 manifest validation**

  ```bash
  npx ui5-linter --filter "**/secrets/**" 2>&1 | tail -10 || echo "(ui5-linter not installed locally; skip)"
  ```

  If the linter isn't available, just verify the XML parses: `xmllint app/admin/secrets/webapp/view/SecretDialog.fragment.xml > /dev/null && echo OK` (Git Bash usually has xmllint).

- [ ] **Step 9.4: Commit**

  ```bash
  git add app/admin/secrets/webapp/view/SecretDialog.fragment.xml
  git commit -m "feat(admin-tile): add Secret Value Panel to dialog (#465)

  Collapsible Panel below metadata fields. Show/Set/Rotate/Clear
  buttons (disabled when isNew=true — can't write to credstore against
  unsaved key). Reveal area visible only when revealedValue is set;
  MessageStrip shows 'Value visible for Ns. Logged in audit trail.'
  per the security trade-off spec."
  ```

---

## Task 10: Add controller handlers (`controller/Secrets.controller.js`)

**Files:**

- Modify: `app/admin/secrets/webapp/controller/Secrets.controller.js`

Adds 5 handlers + 1 helper (`_invokeBoundAction`) + reveal-countdown ticker. ~150 lines.

- [ ] **Step 10.1: Inspect existing controller shape**

  ```bash
  head -40 app/admin/secrets/webapp/controller/Secrets.controller.js
  grep -n '_withCsrf:\|onSave:\|onDelete:\|onCancel:' app/admin/secrets/webapp/controller/Secrets.controller.js
  ```

  Note: `_withCsrf` is at line 178 (per pre-flight Step 0.2). The existing controller uses `function (token) { return fetch(...) }` callback shape. Match this pattern exactly.

- [ ] **Step 10.2: Add `_invokeBoundAction` helper**

  Use Edit. Anchor on the existing `_withCsrf:` line. Insert a new method definition AFTER the `_withCsrf` block's closing `},` (the method blocks in this controller end with `},` not `};`).

  Read enough of the file to find the closing brace of `_withCsrf` first:

  ```bash
  awk '/^    _withCsrf:/,/^    \},/' app/admin/secrets/webapp/controller/Secrets.controller.js | tail -10
  ```

  Then insert AFTER the closing `},`:

  ```javascript

      // Phase 2-C (#465): Invoke a bound action via OData V4 + CSRF.
      // Wraps the existing _withCsrf(callback) helper.
      _invokeBoundAction: function (secretId, actionName, body) {
        var url = "/admin/Secrets(" + secretId + ")/AdminService." + actionName;
        return this._withCsrf(function (token) {
          return fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token,
            },
            body: JSON.stringify(body || {}),
          });
        }).then(async function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
          return res.json();
        });
      },
  ```

  **Note on JS style:** the existing controller uses `var` + `function` rather than `const` + arrow functions. New methods should match (UI5 v1.x compatibility, no `?.` chaining inside the controller for older browsers).

- [ ] **Step 10.3: Add 5 handlers + reveal-countdown ticker**

  After `_invokeBoundAction`, append:

  ```javascript

      // ──────────────────────────────────────────────────────────────────
      // Phase 2-C (#465): Secret value handlers + reveal countdown.
      // ──────────────────────────────────────────────────────────────────

      onRevealValue: function () {
        var self = this;
        var data = this.getView().getModel("dialog").getData();
        // Reveal is a function (GET) not action — no CSRF, no body.
        fetch("/admin/Secrets(" + data.ID + ")/AdminService.revealSecretValue()", {
          credentials: "include",
          headers: { "Accept": "application/json" },
        }).then(function (res) {
          if (!res.ok) return res.text().then(function (t) {
            sap.m.MessageBox.error("Reveal failed: " + (t || res.status));
            throw new Error("reveal failed");
          });
          return res.json();
        }).then(function (result) {
          self._startRevealCountdown(result.value, new Date(result.expiresAt));
        }).catch(function () { /* error already surfaced */ });
      },

      onSetValue: function () {
        var self = this;
        var data = this.getView().getModel("dialog").getData();
        this._openSetValueDialog(function (value) {
          return self._invokeBoundAction(data.ID, "setSecretValue", { value: value })
            .then(function (result) {
              self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
              sap.m.MessageToast.show("Value saved.");
            });
        });
      },

      onRotate: function () {
        var self = this;
        var data = this.getView().getModel("dialog").getData();
        this._invokeBoundAction(data.ID, "rotateSecretValue", {})
          .then(function (result) {
            if (result.rotated === true) {
              self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
              self._showRotatedValueDialog(result.newValue, new Date(result.revealExpiresAt));
            } else {
              self._showVendorRotationGuidance(result.rotationDocsUrl, data.ID);
            }
          })
          .catch(function (e) {
            sap.m.MessageBox.error("Rotate failed: " + e.message);
          });
      },

      onClearValue: function () {
        var self = this;
        var data = this.getView().getModel("dialog").getData();
        sap.m.MessageBox.confirm(
          "Delete the credstore value for '" + data.key + "'? Metadata stays in HANA.",
          {
            onClose: function (action) {
              if (action !== sap.m.MessageBox.Action.OK) return;
              self._invokeBoundAction(data.ID, "clearSecretValue", {})
                .then(function () { sap.m.MessageToast.show("Value cleared."); })
                .catch(function (e) { sap.m.MessageBox.error("Clear failed: " + e.message); });
            },
          }
        );
      },

      // Reveal countdown — server-supplied expiry; clamped against negative drift.
      // Tracks the active timer so a 2nd Show click cancels the 1st ticker (race fix).
      _startRevealCountdown: function (value, expiresAt) {
        if (this._revealTickerId) {
          clearTimeout(this._revealTickerId);
          this._revealTickerId = null;
        }
        var model = this.getView().getModel("dialog");
        model.setProperty("/revealedValue", value);
        this._tickReveal(model, expiresAt);
      },

      _tickReveal: function (model, expiresAt) {
        var self = this;
        var now = Date.now();
        var remaining = Math.max(0, expiresAt.getTime() - now);
        model.setProperty("/revealSecondsLeft", Math.ceil(remaining / 1000));
        if (remaining <= 0) {
          model.setProperty("/revealedValue", "");
          model.setProperty("/revealSecondsLeft", 0);
          this._revealTickerId = null;
          return;
        }
        // Recursive setTimeout (vs setInterval) — recalculates remaining each
        // tick from wall-clock, so display stays in sync with server-supplied
        // expiresAt even when the tab is backgrounded (browsers throttle
        // setInterval aggressively but re-bias each setTimeout).
        this._revealTickerId = setTimeout(function () {
          self._tickReveal(model, expiresAt);
        }, 1000);
      },

      // ──────────────────────────────────────────────────────────────────
      // Sub-dialogs: SetValue (masked input), RotatedValue (auto-hide
      // reveal of the new value), VendorRotation (guidance + paste bridge).
      // ──────────────────────────────────────────────────────────────────

      _openSetValueDialog: function (onSave) {
        var oDialog = new sap.m.Dialog({
          title: "{i18n>dialogTitleSetValue}",
          contentWidth: "30rem",
          beginButton: new sap.m.Button({ text: "Save", type: "Emphasized", press: function () {
            var value = oInput.getValue();
            if (!value) { sap.m.MessageBox.error("Value cannot be empty."); return; }
            onSave(value).then(function () { oDialog.close(); oDialog.destroy(); });
          }}),
          endButton: new sap.m.Button({ text: "Cancel", press: function () {
            oDialog.close(); oDialog.destroy();
          }}),
        });
        var oInput = new sap.m.Input({ type: "Password", placeholder: "New secret value" });
        oDialog.addContent(new sap.m.VBox({
          items: [
            new sap.m.Label({ text: "Type or paste the new value:" }),
            oInput,
          ],
        }).addStyleClass("sapUiSmallMargin"));
        oDialog.open();
      },

      _showRotatedValueDialog: function (newValue, expiresAt) {
        // Pop a modal showing the rotated value + auto-hide countdown.
        // Reuses the same _startRevealCountdown ticker; revealedValue model
        // is also bound here. Admin copies the value before auto-hide.
        var self = this;
        this._startRevealCountdown(newValue, expiresAt);
        sap.m.MessageBox.information(
          "New value generated. Visible for ~30s in the dialog field above.",
          { title: "{i18n>dialogTitleRotated}" }
        );
      },

      _showVendorRotationGuidance: function (rotationDocsUrl, secretId) {
        var self = this;
        var oDialog = new sap.m.Dialog({
          title: "{i18n>dialogTitleVendorRotation}",
          contentWidth: "32rem",
          beginButton: new sap.m.Button({ text: "Paste new value", type: "Emphasized", press: function () {
            oDialog.close(); oDialog.destroy();
            // Bridge to the Set Value flow — admin pastes the just-rotated value.
            var data = self.getView().getModel("dialog").getData();
            self._openSetValueDialog(function (value) {
              return self._invokeBoundAction(data.ID, "setSecretValue", { value: value })
                .then(function (result) {
                  self.getView().getModel("dialog").setProperty("/lastRotatedAt", result.lastRotatedAt);
                  sap.m.MessageToast.show("Rotation complete.");
                });
            });
          }}),
          endButton: new sap.m.Button({ text: "Cancel", press: function () {
            oDialog.close(); oDialog.destroy();
          }}),
        });
        var oVBox = new sap.m.VBox({ items: [
          new sap.m.Text({ text: "This kind of secret can't be self-rotated. Mint a new value at the vendor's UI, then click 'Paste new value' below." }),
          new sap.m.Link({
            text: "Rotation docs",
            href: rotationDocsUrl || "",
            target: "_blank",
            visible: !!rotationDocsUrl,
          }),
        ]}).addStyleClass("sapUiSmallMargin");
        oDialog.addContent(oVBox);
        oDialog.open();
      },
  ```

- [ ] **Step 10.4: Syntax check the modified controller**

  ```bash
  node --check app/admin/secrets/webapp/controller/Secrets.controller.js && echo OK
  ```

  Expected: `OK`. Common pitfalls: missing comma between method blocks, mismatched `var self = this;` referencing, missing `sap.ui.define(...)` deps.

- [ ] **Step 10.5: Audit `sap.ui.define` dependency array** (IMPORTANT 6)

  Verified against codebase: the existing controller's `sap.ui.define([...])` array currently lists (approx):
  `Controller, Fragment, JSONModel, MessageToast, MessageBox`.

  The handler code from Step 10.3 references additional UI5 modules (`sap.m.Dialog`, `sap.m.Button`, `sap.m.Input`, `sap.m.Label`, `sap.m.VBox`, `sap.m.Text`, `sap.m.Link`). Two equally valid resolution strategies — pick one:

  **Strategy A — keep `sap.m.X` global references in handler code**

  If the existing handler code in the file (pre-edit) already uses `sap.m.MessageBox` global rather than the imported `MessageBox` identifier, keep that style. The `sap.ui.define` array does NOT need new entries — UI5 resolves global module aliases at runtime. Match the existing controller's style.

  **Strategy B — add to the dependency array (cleaner)**

  If the existing code uses imported identifiers (`MessageBox.error(...)` not `sap.m.MessageBox.error(...)`), extend the array:

  ```javascript
  sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",          // NEW
    "sap/m/Button",          // NEW
    "sap/m/Input",           // NEW
    "sap/m/Label",           // NEW
    "sap/m/VBox",            // NEW
    "sap/m/Text",            // NEW
    "sap/m/Link",            // NEW
  ], function (Controller, Fragment, JSONModel, MessageBox, MessageToast, Dialog, Button, Input, Label, VBox, Text, Link) {
    // ...
  }
  ```

  Then rewrite the handler code from Step 10.3 to use imported identifiers (`new Dialog({...})` instead of `new sap.m.Dialog({...})`, etc.).

  **Audit script — run after Step 10.3 + 10.5:**

  ```bash
  # Extract the current sap.ui.define dependency array:
  node -e "
    const src = require('fs').readFileSync('app/admin/secrets/webapp/controller/Secrets.controller.js','utf8');
    const m = src.match(/sap\.ui\.define\(\[([^\]]+)\]/s);
    const deps = m ? m[1].split(',').map(s => s.trim().replace(/[\"']/g, '')).filter(Boolean) : [];
    console.log('deps:', deps);
    // List of sap.m.X references in the new handler code
    const refs = [...src.matchAll(/new sap\.m\.(\w+)/g)].map(x => 'sap/m/' + x[1]);
    console.log('sap.m refs:', [...new Set(refs)]);
    // Anything in refs not in deps?
    const depsSet = new Set(deps.map(d => d.replace(/^sap\./, 'sap/').replace(/\./g, '/')));
    const missing = [...new Set(refs)].filter(r => !depsSet.has(r));
    console.log('missing from define array:', missing);
  "
  ```

  Expected: `missing from define array: []`. If anything is missing AND Strategy A is in use (global refs OK), this is informational only. If Strategy B is in use and `missing` is non-empty, add those modules to the `sap.ui.define` array.

  Common pitfall: parameter order in the callback must match array order exactly. Use Edit on BOTH the array AND the function signature if changing this.

- [ ] **Step 10.6: Commit**

  ```bash
  git add app/admin/secrets/webapp/controller/Secrets.controller.js
  git commit -m "feat(admin-tile): Secrets value handlers (#465)

  5 handlers + _invokeBoundAction helper (wraps _withCsrf) + reveal
  countdown ticker with double-click race protection via
  _revealTickerId.

  onRevealValue: GET function, no CSRF.
  onSetValue: opens masked-input sub-dialog, calls setSecretValue.
  onRotate: dispatches on rotated boolean — self-gen shows new value,
    vendor-side shows guidance + paste-bridge.
  onClearValue: confirm + DELETE.

  Recursive setTimeout (not setInterval) so the countdown stays in
  sync with server-supplied expiresAt even when tab is backgrounded.

  _withCsrf callback wrapper matches existing pattern at controller
  line 178 — Phase 2-C extends, doesn't refactor."
  ```

---

## Task 11: Add i18n keys (`i18n/i18n.properties`)

**Files:**

- Modify: `app/admin/secrets/webapp/i18n/i18n.properties`

- [ ] **Step 11.1: Append keys**

  ```bash
  cat app/admin/secrets/webapp/i18n/i18n.properties
  ```

  Append the new keys at the end (don't duplicate existing keys):

  ```properties

  # Phase 2-C (#465): Secret Value Panel
  panelSecretValue=Secret Value
  buttonShowValue=Show Value
  buttonSetValue=Set Value
  buttonRotate=Rotate
  buttonClear=Clear Value
  dialogTitleSetValue=Set Secret Value
  dialogTitleRotated=Value Rotated
  dialogTitleVendorRotation=Vendor-Side Rotation
  confirmClearValue=Delete the credstore value for '{0}'? Metadata stays in HANA.
  revealMessageStrip=Value visible for {0}s. Logged in audit trail.
  ```

  Match the existing file's line-ending style (`\n` or `\r\n` — preserve whatever is already there).

- [ ] **Step 11.2: Verify the file parses**

  ```bash
  grep -c '^[a-zA-Z]' app/admin/secrets/webapp/i18n/i18n.properties
  ```

  Expected: count went up by 10 (the new keys above; comment line doesn't count due to `#` prefix). Adjust expectation if you also kept the existing keys.

- [ ] **Step 11.3: Commit**

  ```bash
  git add app/admin/secrets/webapp/i18n/i18n.properties
  git commit -m "i18n(secrets): Phase 2-C value-panel keys (#465)

  10 new keys for the Secret Value Panel: panel header, 4 button
  labels, 3 dialog titles, confirm-clear text, reveal message-strip
  template."
  ```

---

## Task 12: Append "Phase 2-C" section to operations doc

**Files:**

- Modify: `docs/developers/operations/runtime-config.md`

- [ ] **Step 12.1: Check the existing doc has an appendable structure**

  ```bash
  tail -30 docs/developers/operations/runtime-config.md
  ```

  Confirm: file is structured as appendable per-phase sections (one for #463 KG, one for #482 Secrets, one for #491 Phase 3 long-tail). New section goes at end.

- [ ] **Step 12.2: Append the Phase 2-C section**

  Append to the end of `docs/developers/operations/runtime-config.md`:

  ```markdown

  ## Phase 2-C: Encrypted secrets via BTP Credential Store (#465 / PR #_____)

  Extends the metadata-only `Secrets` entity from #482 with value-storage in
  **BTP Credential Store**. HANA stays metadata-only; values live in credstore
  keyed by `Secrets.key`.

  ### What's where

  | Layer | Stores | Access |
  | --- | --- | --- |
  | HANA `Secrets` entity | metadata (key, description, kind, rotationOwner, rotationDocsUrl, expiresAt, lastRotatedAt) | OData V4 via `/admin/Secrets` |
  | BTP Credential Store | values (plaintext, JWE-on-wire) | Via `srv/lib/credstore.js` chokepoint |

  The HANA `Secrets.key` value doubles as the credstore alias. 1:1 join.

  ### 4 admin-tile operations

  All bound to a row in `/admin/Secrets` (open the row's edit dialog, expand
  the "Secret Value" Panel):

  - **Show Value** — fetches the current value, displays for ~30 seconds in
    an editable-false Input, auto-hides at the server-supplied `expiresAt`.
    Each Show emits a `SecretValueRead` audit event tagged with the admin's
    identity. **Do not click during screenshare**; do not screenshot.
  - **Set Value** — opens a sub-dialog with a single masked-Password input.
    On Save, writes the value to credstore and stamps `lastRotatedAt`.
  - **Rotate** — for self-gen kinds (`salt`, `content-api-key`), mints a
    fresh 32-byte hex value (64 chars) and writes it. For vendor-side kinds
    (`github-pat`, `service-key`, `smtp-credential`, `other`), opens a
    guidance dialog with the row's `rotationDocsUrl` link + a "Paste new
    value" button bridging to the Set Value flow.
  - **Clear Value** — deletes the credstore entry. Metadata row stays.

  ### Reveal-window behavior

  - Default 30 seconds (`REVEAL_WINDOW_MS = 30_000` in
    `srv/admin-service.js`).
  - Server-supplied `expiresAt` in the response; client trusts that
    timestamp.
  - Client tick (recursive `setTimeout`) updates the visible countdown each
    second; auto-hides at expiry.
  - Re-clicking Show before the first reveal expires cancels the prior
    timer and starts fresh (race guard via `_revealTickerId`).

  ### Audit logs

  - **CRUD on Secrets metadata** (description, expiresAt, etc.) — captured
    automatically by `@AuditLog.Operation` annotation on the entity (added
    in `db/audit-logging.cds` as part of #465).
  - **Custom OData operations** (setSecretValue, rotateSecretValue,
    clearSecretValue, revealSecretValue) — custom OData V4 functions /
    actions do NOT fire the CRUD interceptors. Each handler emits an
    explicit `cds.audit.log()` call with event name `SecretValueRead` /
    `SecretValueRotated` / `SecretValueRotateAttempted` /
    `SecretValueCleared`.

  ### Where to find audit events

  Per the `@cap-js/audit-logging` plugin's output target (configured in
  `package.json` `cds.requires['audit-log']`). Typically goes to the
  SAP Audit Log service on BTP; in DEV-only contexts may write to
  console. Check plugin docs for the canonical place to query in your env.

  ### Vendor-side rotation runbook

  For `github-pat` / `service-key` / `smtp-credential` / `other`:

  1. Click **Rotate** in the admin tile → dialog opens.
  2. Click the **Rotation docs** link → vendor's UI (GitHub, BTP cockpit,
     etc.).
  3. Mint a new credential at the vendor's UI.
  4. Click **Paste new value** in the dialog → sub-dialog with masked
     input.
  5. Paste the new value, click Save.
  6. The tile stamps `lastRotatedAt`. The old credential should be
     revoked at the vendor side independently — Phase 2-C doesn't
     automate revocation.

  ### Local hybrid dev

  Bind the credstore service for local development:

  ```bash
  cds bind --to tutorials-credstore --kind credentials
  ```

  This populates `VCAP_SERVICES` for `npm run dev:hybrid` so the credstore
  lib resolves a real binding instead of throwing.

  ### Security trade-offs of Show Value (documented)

  The Show Value flow exposes plaintext to the admin's browser for ~30s.
  Three known leak paths, all bounded:

  1. **Browser DevTools network panel** logs the response body. Mitigated
     by `Cache-Control: no-store, no-cache, must-revalidate, private` on
     the response, plus audit-log entry on every reveal.
  2. **Screenshare** exposes the revealed field. MessageStrip displays
     "Value visible for Ns. Logged in audit trail." to give admins pause.
     Auto-hide bounds the exposure.
  3. **Browser autosave / password-manager extensions** could capture
     revealed values. Out-of-band (admin's laptop hygiene).

  CAP audit-logging records every reveal with the calling admin's
  identity. Trade-off accepted for usability: admins need to copy
  current values (e.g. to test a token) without rotating.

  ### Rotation owner notification (out of scope of #465)

  The daily expiry-check cron (#482) still fires expiry warnings via
  `/admin/Secrets` `secretWarnings()` function. Phase 2-C does NOT add
  programmatic vendor-rotation. That's a Phase 3+ follow-up if needed.
  ```

- [ ] **Step 12.3: Commit**

  ```bash
  git add docs/developers/operations/runtime-config.md
  git commit -m "docs(ops): Phase 2-C section in runtime-config runbook (#465)

  Per-phase appended section (existing doc designed to be appendable).
  Covers: what's-where layer split, 4 admin-tile operations, reveal
  semantics, audit log mapping, vendor-side rotation runbook, local
  hybrid dev binding, documented security trade-offs of Show Value."
  ```

---

## Task 13: End-to-end verification + finalize

- [ ] **Step 13.1: Run all unit tests**

  ```bash
  npx vitest run 2>&1 | tail -15
  ```

  Expected: existing tests still pass + the 14 new ones (6 credstore lib + 8 handler) pass. Watch for any test that loads `srv/admin-service.js` end-to-end — the `auditEvent()` helper added in Task 6 wraps `cds.connect.to('audit-log')` in `.catch(() => null)`, so test contexts without the audit-log binding are safely silent. If a test fails with "audit binding required" or similar, verify the helper's catch is intact.

- [ ] **Step 13.2: Run admin-shell build**

  ```bash
  npm --prefix app/admin-shell run build 2>&1 | tail -10
  ```

  Expected: build succeeds. UI5 build catches XML / JS errors in the controller.

- [ ] **Step 13.3: Smoke boot CAP service**

  ```bash
  timeout 20 npx cds run --in-memory 2>&1 | tail -20 || true
  ```

  Expected: server boots; route table includes `/admin/Secrets`,
  `/admin/Secrets(<key>)/AdminService.setSecretValue` etc.

- [ ] **Step 13.4: Confirm commits + push**

  ```bash
  git log --oneline main..HEAD | head -20
  ```

  Expected: ~12 commits (Tasks 1-12), one per task, descriptive messages.

  Push:

  ```bash
  git push -u origin worktree-issue-465-encrypted-secrets-credstore
  ```

- [ ] **Step 13.5: Open the PR**

  Use the PR-body draft from the spec's Section 7 (look for `## PR body skeleton` in `docs/superpowers/specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md`). Edit the placeholder PR number out of the operations-doc commit message (Task 12.2) after the PR opens.

  ```bash
  gh pr create --base main --head worktree-issue-465-encrypted-secrets-credstore \
    --title "feat(secrets): Phase 2-C encrypted values via BTP Credential Store (#465)" \
    --body "$(cat <<'BODY'
  Closes #465.

  Phase 2-C of the runtime-config research from #444. Adds encrypted-value
  storage to the existing Secrets HANA entity (metadata-only from #482) via
  BTP Credential Store. HANA stays metadata-only; values live in credstore
  keyed by Secrets.key.

  [full body content per spec's PR body skeleton — copy from
   docs/superpowers/specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md]
  BODY
  )"
  ```

- [ ] **Step 13.6: Update operations doc with the PR number**

  After the PR opens, edit `docs/developers/operations/runtime-config.md` to
  replace `(#465 / PR #_____)` with the actual PR number. Amend the
  operations-doc commit (Task 12) or add a small fixup commit. Push.

---

## Acceptance criteria (verify before requesting review)

- [ ] 14 unit tests pass (`npx vitest run test/unit/lib/credstore.test.js test/unit/admin-secret-value-handlers.test.js`).
- [ ] All 4 OData operations registered (visible in `/admin/$metadata` after smoke boot).
- [ ] Admin-shell build succeeds; controller and dialog compile.
- [ ] `db/audit-logging.cds` has the new `@AuditLog.Operation` annotation on `Secrets`.
- [ ] `mta.yaml` binds `tutorials-credstore` to srv module.
- [ ] `package.json` has `jose ^5.x`.
- [ ] `docs/developers/operations/runtime-config.md` has the Phase 2-C section.

## Out of scope

- DEV deploy smoke (real credstore E2E) — manual step after PR merge.
- Programmatic vendor rotation (e.g. auto-mint GitHub PAT) — Phase 3+ if needed.
- Multi-namespace credstore (multi-tenant) — single `tutorials` namespace per env.
- `listSecrets()` from credstore — HANA `Secrets` is the inventory.
- mTLS plan for credstore binding — default + JWE is sufficient.

## References

- Spec: [docs/superpowers/specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md](../specs/2026-06-20-issue-465-encrypted-secrets-credstore-design.md)
- Sibling plans (templates): #463 / #482 / #491 plans in same directory
- Memory: `feedback_subagent_writes_can_leak_to_parent_repo`, `feedback_module_singletons_in_vitest_cds`, `npm_security_config`, `sbss_deprecated`
