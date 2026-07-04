# CAP 10 AI improvements — PR 1: Consolidate AI configuration resolution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse three duplicated LLM configuration-resolution blocks into two exported functions in `srv/lib/chat-settings-resolver.js`, so every AI-call site in the app resolves `modelName`, `deploymentId`, and embedding `model` through one file.

**Architecture:** Extract a private `readChatSettings()` helper (tolerant of the build-pipeline vs. runtime CDS-entities distinction) and expose `resolveChatLlmSettings()` (already exists — refactor to use the helper) plus a new `resolveEmbeddingSettings()`. Rewire the two inline duplicates (`category-classifier-llm.js`, `os-variant-generator.js`) plus `explainer-generator.js`'s hardcoded-model pattern to call the shared resolver. Rewire the embedding-model readers (10+ jobs and one library) to call `resolveEmbeddingSettings()` instead of doing their own `SELECT.one.from(ChatSettings)`.

**Tech Stack:** Node.js 22, `@sap/cds` 10.x, `@sap-ai-sdk/orchestration@^2.12.0`, `@sap-ai-sdk/foundation-models@^2.12.0`, Vitest 4 (unit project only — no hybrid tests added).

## Global Constraints

- **No prompt / model / eval logic changes.** Plumbing swap only.
- **No signature changes** to `embed(inputs, model)`, `OrchestrationClient`, `chatCompletion`, or `client.stream`.
- **`chat-orchestrator.js` `streamChat()` gets NO changes** — it receives `deploymentId`/`modelName` as params from `chat-service.js`; that's already the correct per-request-override pattern.
- **Zero-regression grep**: after the refactor, these tokens appear ONLY in `srv/lib/chat-settings-resolver.js` (not in any caller):
  - `settings?.MODELNAME`
  - `settings?.DEPLOYMENTID`
  - `CHAT_MODEL_NAME` (as an env-var read)
  - `CHAT_DEPLOYMENT_ID` (as an env-var read)
  - `CHAT_EMBEDDING_MODEL` (as an env-var read)
  - `'text-embedding-3-small'` (as a fallback default literal)
  - `'anthropic--claude-4.6-sonnet'` (as a fallback default literal)
- **Behaviour change explicitly accepted:** `explainer-generator.js` switches from hardcoded `'anthropic--claude-4.6-sonnet'` to `ChatSettings.modelName`, matching every other LLM call site. Downside: an admin who picks a model missing from `_token-cost.js` `RATES` gets a `"no rates for model 'X'"` throw on cost calculation (same failure mode as every other LLM call today).
- **`resolveChatLlmSettings()` must throw** with the existing diagnostic message when both `ChatSettings.deploymentId` and `CHAT_DEPLOYMENT_ID` are unresolvable. Preserves the issue #318 fix.
- **Follow the project's TDD idiom** (see `srv/lib/__tests__/category-classifier-llm.test.js:1-30`): `vi.mock('@sap-ai-sdk/orchestration', ...)`, `vi.mock('@sap/cds', ...)`, and `globalThis.SELECT = ...` shim.
- **File structure:** all changes are in `srv/`, `srv/lib/`, `srv/jobs/`, and `srv/lib/__tests__/`. No schema changes, no `db/`, no `mta.yaml`, no `package.json` changes.

## File Structure

**Modify:**
- `srv/lib/chat-settings-resolver.js` — extract `readChatSettings()` helper, add `resolveEmbeddingSettings()` export.
- `srv/lib/category-classifier-llm.js` — delete ~30-line inline resolver block, call `resolveChatLlmSettings()`.
- `srv/lib/os-variant-generator.js` — delete `resolveSettings()` function, call `resolveChatLlmSettings()`.
- `srv/lib/explainer-generator.js` — remove `DEFAULT_MODEL` const, call `resolveChatLlmSettings()`.
- `srv/lib/chat-orchestrator.js` — replace inline `ChatSettings.embeddingModel` read in `expandSearchConcepts` dispatch with `resolveEmbeddingSettings()`.
- `srv/search-service.js` — replace inline `settings.embeddingModel || 'text-embedding-3-small'` fallback with `resolveEmbeddingSettings()`.
- `srv/lib/embedding-pipeline.js` — grep-audit only; no change expected (only assigns to `embeddingModel` output field).
- `srv/lib/embedding-query.js` — grep-audit only; no change expected (only filters on `embeddingModel`).
- `srv/jobs/concept-embedding-backfill.js` — replace inline `SELECT.one.from(ChatSettings).columns('embeddingModel')` with `resolveEmbeddingSettings()`.
- `srv/jobs/fetch-api-docs-job.js` — same.
- `srv/jobs/fetch-blog-posts-job.js` — same.
- `srv/jobs/fetch-community-events-job.js` — same.
- `srv/jobs/fetch-discovery-missions-job.js` — same.
- `srv/jobs/fetch-help-docs-job.js` — same.
- `srv/jobs/fetch-learning-journeys-job.js` — same.
- `srv/jobs/fetch-samples-job.js` — same.
- `srv/jobs/fetch-videos-job.js` — same.

**Create:**
- `srv/lib/__tests__/chat-settings-resolver.test.js` — full-coverage unit tests for both exported functions.

---

## Task 1: Refactor `chat-settings-resolver.js` — extract helper, add `resolveEmbeddingSettings()`

**Files:**
- Modify: `srv/lib/chat-settings-resolver.js`
- Create: `srv/lib/__tests__/chat-settings-resolver.test.js`

**Interfaces:**
- Consumes: `@sap/cds` (log, entities, connect.to('db'))
- Produces:
  - `resolveChatLlmSettings(): Promise<{ modelName: string, deploymentId: string }>` — unchanged signature, refactored body. Throws when `deploymentId` is unresolvable.
  - `resolveEmbeddingSettings(): Promise<{ model: string }>` — NEW.

- [ ] **Step 1: Write the failing test — file skeleton + first two cases**

Create `srv/lib/__tests__/chat-settings-resolver.test.js` with the mock setup and the first two test cases. This drives the `readChatSettings()` extraction.

```js
// srv/lib/__tests__/chat-settings-resolver.test.js
// TDD tests for the shared LLM+embedding configuration resolver.
// See docs/superpowers/plans/2026-07-04-959-pr1-consolidate-ai-resolution.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @sap/cds so cds.log, cds.entities, cds.connect.to('db') are controllable.
const dbRunMock = vi.fn();
const chatSettingsProxy = {}; // sentinel — SELECT.one.from(ChatSettings) picks the mocked resolver
const cdsEntitiesMock = vi.fn(() => ({ ChatSettings: chatSettingsProxy }));

vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  return {
    default: {
      log,
      entities: cdsEntitiesMock,
      connect: { to: vi.fn(async () => ({ run: dbRunMock })) },
    },
  };
});

// SELECT.one.from(ChatSettings) is a global cds.ql expression. Shim it per test.
let selectOneFromResult = null;
beforeEach(() => {
  selectOneFromResult = null;
  globalThis.SELECT = {
    one: {
      from: () => ({ then: (resolve) => resolve(selectOneFromResult) }),
    },
  };
  dbRunMock.mockReset();
  cdsEntitiesMock.mockReturnValue({ ChatSettings: chatSettingsProxy });
  delete process.env.CHAT_MODEL_NAME;
  delete process.env.CHAT_DEPLOYMENT_ID;
  delete process.env.CHAT_EMBEDDING_MODEL;
});

afterEach(() => {
  vi.resetModules();
});

describe('resolveChatLlmSettings', () => {
  it('returns ChatSettings row values when both fields present (CDS-entities path)', async () => {
    selectOneFromResult = { modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'dep-abc' };
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'dep-abc' });
  });

  it('falls back to CHAT_MODEL_NAME and CHAT_DEPLOYMENT_ID env when row is empty', async () => {
    selectOneFromResult = null;
    process.env.CHAT_MODEL_NAME = 'gpt-4o';
    process.env.CHAT_DEPLOYMENT_ID = 'env-dep';
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'gpt-4o', deploymentId: 'env-dep' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/chat-settings-resolver.test.js`

Expected: The first test passes (resolver already handles this path), the second passes too if the existing resolver's env fallback works. If both pass without changes, that's fine — this test file's goal is regression-guard, not TDD-forcing a change. Continue to Step 3.

- [ ] **Step 3: Add the third + fourth cases — build-pipeline raw-SQL path + `deploymentId` throw**

Append to `srv/lib/__tests__/chat-settings-resolver.test.js`:

```js
  it('falls back to raw-SQL path when cds.entities is not a function (build-pipeline context)', async () => {
    cdsEntitiesMock.mockImplementation(() => { throw new Error('cds.entities not initialized'); });
    // Force cds.entities to be non-function so the resolver picks the raw-SQL branch.
    const cds = (await import('@sap/cds')).default;
    Object.defineProperty(cds, 'entities', { value: undefined, configurable: true });
    dbRunMock.mockResolvedValueOnce([{ MODELNAME: 'anthropic--claude-4.6-sonnet', DEPLOYMENTID: 'hana-dep' }]);
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveChatLlmSettings();
    expect(result).toEqual({ modelName: 'anthropic--claude-4.6-sonnet', deploymentId: 'hana-dep' });
    // Restore cds.entities for later tests.
    Object.defineProperty(cds, 'entities', { value: cdsEntitiesMock, configurable: true });
  });

  it('throws with a diagnostic message when deploymentId is unresolvable', async () => {
    selectOneFromResult = { modelName: 'anthropic--claude-4.6-sonnet', deploymentId: null };
    const { resolveChatLlmSettings } = await import('../chat-settings-resolver.js');
    await expect(resolveChatLlmSettings()).rejects.toThrow(/No deploymentId for SAP AI Hub call/);
  });
});
```

- [ ] **Step 4: Run tests to verify — third + fourth pass**

Run: `npx vitest run srv/lib/__tests__/chat-settings-resolver.test.js`

Expected: All 4 tests pass against the CURRENT `chat-settings-resolver.js` (they're regression tests for behaviour we're keeping). If any fail, fix the tests (the source is correct today).

- [ ] **Step 5: Add the `resolveEmbeddingSettings` test suite**

Append to `srv/lib/__tests__/chat-settings-resolver.test.js`:

```js
describe('resolveEmbeddingSettings', () => {
  it('returns ChatSettings.embeddingModel when present', async () => {
    selectOneFromResult = { embeddingModel: 'text-embedding-3-large' };
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-large' });
  });

  it('falls back to CHAT_EMBEDDING_MODEL env when row is empty', async () => {
    selectOneFromResult = null;
    process.env.CHAT_EMBEDDING_MODEL = 'text-embedding-ada-002';
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-ada-002' });
  });

  it('falls back to the hardcoded default when neither ChatSettings nor env is set', async () => {
    selectOneFromResult = null;
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-small' });
  });

  it('handles the raw-SQL UPPERCASE column shape (HANA build-pipeline path)', async () => {
    const cds = (await import('@sap/cds')).default;
    Object.defineProperty(cds, 'entities', { value: undefined, configurable: true });
    dbRunMock.mockResolvedValueOnce([{ EMBEDDINGMODEL: 'text-embedding-3-large' }]);
    const { resolveEmbeddingSettings } = await import('../chat-settings-resolver.js');
    const result = await resolveEmbeddingSettings();
    expect(result).toEqual({ model: 'text-embedding-3-large' });
    Object.defineProperty(cds, 'entities', { value: cdsEntitiesMock, configurable: true });
  });
});
```

- [ ] **Step 6: Run tests to verify they FAIL (`resolveEmbeddingSettings` doesn't exist yet)**

Run: `npx vitest run srv/lib/__tests__/chat-settings-resolver.test.js`

Expected: The 4 new tests fail with "resolveEmbeddingSettings is not a function" or similar. The 4 earlier tests still pass.

- [ ] **Step 7: Refactor `chat-settings-resolver.js` — extract helper + add embedding resolver**

Replace the entire body of `srv/lib/chat-settings-resolver.js` with:

```js
// srv/lib/chat-settings-resolver.js
// Resolves modelName + deploymentId (for orchestration) and model (for
// embeddings) from ChatSettings, env vars, and hardcoded defaults. Every
// AI-call site in the app resolves configuration through this file — no
// inline duplication. See docs/superpowers/plans/2026-07-04-959-pr1-consolidate-ai-resolution.md.
//
// resolveChatLlmSettings() resolution order:
//   1. ChatSettings.modelName / deploymentId (CAP entity, lowercase keys)
//   2. ChatSettings raw-SQL UPPERCASE column shape (HANA build-pipeline path)
//   3. process.env.CHAT_MODEL_NAME / CHAT_DEPLOYMENT_ID
//   4. modelName: hardcoded 'anthropic--claude-4.6-sonnet'
//      deploymentId: NO fallback — throws with a diagnostic message.
//
// resolveEmbeddingSettings() resolution order:
//   1. ChatSettings.embeddingModel (CAP entity, lowercase keys)
//   2. ChatSettings raw-SQL UPPERCASE column shape (HANA build-pipeline path)
//   3. process.env.CHAT_EMBEDDING_MODEL
//   4. Hardcoded 'text-embedding-3-small'
//   There is NO embeddingDeploymentId column — @sap-ai-sdk/foundation-models
//   resolves the deployment from the model name via the aicore binding.
//
// The throw-on-null-deploymentId is the issue #318 fix (surfaces the failure
// immediately with an actionable message; before, callers passed null to the
// SDK and got an opaque "upstream error" 3 seconds later).

import cds from '@sap/cds';

const LOG = cds.log('chat-settings-resolver');

const DEFAULT_MODEL_NAME = 'anthropic--claude-4.6-sonnet';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Read the singleton ChatSettings row. Tolerant of build-pipeline contexts
 * where cds.entities is undefined (CAP hasn't booted via cds.serve).
 * On HANA the raw-SQL path returns UPPERCASE column names.
 *
 * @returns {Promise<object|null>} row (lowercase or UPPERCASE keys) or null on any failure
 */
async function readChatSettings() {
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(ChatSettings)) ?? null;
    }
    // Build-pipeline path: cds.entities not initialized, try raw SQL.
    const db = await cds.connect.to('db');
    const rows = await db.run(
      'SELECT modelName, deploymentId, embeddingModel FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
    );
    return rows?.[0] ?? null;
  } catch (err) {
    LOG.warn('ChatSettings read failed; using env-var defaults', err.message);
    return null;
  }
}

/**
 * Resolve modelName + deploymentId for an OrchestrationClient call.
 *
 * @returns {Promise<{ modelName: string, deploymentId: string }>}
 * @throws if deploymentId resolves to null/empty after the full fallback chain.
 *   Error message names the env var and the ChatSettings column so the
 *   operator can fix it without spelunking through srv/lib.
 */
export async function resolveChatLlmSettings() {
  const settings = await readChatSettings();

  const modelName = settings?.modelName
    || settings?.MODELNAME
    || process.env.CHAT_MODEL_NAME
    || DEFAULT_MODEL_NAME;

  const deploymentId = settings?.deploymentId
    || settings?.DEPLOYMENTID
    || process.env.CHAT_DEPLOYMENT_ID
    || null;

  if (!deploymentId) {
    throw new Error(
      'No deploymentId for SAP AI Hub call. Set ChatSettings.deploymentId ' +
      '(via /admin-ui/#joule-settings or raw SQL on COM_SAP_DEVELOPERS_IMS_CHATSETTINGS), ' +
      'or set the CHAT_DEPLOYMENT_ID env var. ' +
      'See docs/developers/operations/ai-author-ci-setup.md.'
    );
  }

  return { modelName, deploymentId };
}

/**
 * Resolve the embedding model for AzureOpenAiEmbeddingClient calls.
 *
 * @returns {Promise<{ model: string }>}
 */
export async function resolveEmbeddingSettings() {
  const settings = await readChatSettings();
  const model = settings?.embeddingModel
    || settings?.EMBEDDINGMODEL
    || process.env.CHAT_EMBEDDING_MODEL
    || DEFAULT_EMBEDDING_MODEL;
  return { model };
}
```

- [ ] **Step 8: Run tests to verify all pass**

Run: `npx vitest run srv/lib/__tests__/chat-settings-resolver.test.js`

Expected: All 8 tests pass.

- [ ] **Step 9: Run the wider unit test suite to catch collateral breakage**

Run: `npx vitest run srv/lib/__tests__/`

Expected: All tests pass. The extraction preserves behaviour so `ai-quiz-generator.test.js`, `category-classifier-llm.test.js`, `code-check-*` tests all stay green.

- [ ] **Step 10: Commit**

```bash
git add srv/lib/chat-settings-resolver.js srv/lib/__tests__/chat-settings-resolver.test.js
git commit -m "refactor(#959): extract readChatSettings helper; add resolveEmbeddingSettings

PR 1 of the CAP 10 AI improvements split. Adds:

- readChatSettings() private helper — single source of the CDS-entities /
  raw-SQL / UPPERCASE-column tolerance code.
- resolveEmbeddingSettings() exported — returns { model } for
  AzureOpenAiEmbeddingClient callers. Fallback chain matches
  resolveChatLlmSettings.
- srv/lib/__tests__/chat-settings-resolver.test.js — 8 cases covering
  both resolvers, both DB-read paths, all fallback branches, and the
  deploymentId-throws case (issue #318).

No behaviour change to resolveChatLlmSettings — same signature, same
fallback chain, same throw. Callers in later tasks will pick up the new
export."
```

---

## Task 2: Rewire `category-classifier-llm.js`

**Files:**
- Modify: `srv/lib/category-classifier-llm.js`
- Test: `srv/lib/__tests__/category-classifier-llm.test.js` (regression only, no additions)

**Interfaces:**
- Consumes: `resolveChatLlmSettings()` from Task 1.
- Produces: no interface changes to `classifyViaLlm`.

- [ ] **Step 1: Verify the existing test suite passes on current code**

Run: `npx vitest run srv/lib/__tests__/category-classifier-llm.test.js`

Expected: All existing tests pass. This is the regression baseline for Task 2.

- [ ] **Step 2: Edit `srv/lib/category-classifier-llm.js` — replace inline resolver with import**

At the top of `srv/lib/category-classifier-llm.js`, ensure the import block includes the resolver import. Locate the current imports (should be around lines 12–14):

```js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
```

Change to:

```js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
```

- [ ] **Step 3: Replace the inline resolver block**

Locate the ~30-line block starting near line 60 (the `// 1. Read ChatSettings — tolerant of build-pipeline contexts` comment through the `const deploymentId = ... || null;` line). Delete that block, along with any `LOG` variable specifically used by it (keep `LOG` if used elsewhere in the file). Replace with:

```js
  // Resolve modelName + deploymentId. See srv/lib/chat-settings-resolver.js.
  // Throws (rather than passing null deploymentId to the SDK) when both
  // ChatSettings.deploymentId and CHAT_DEPLOYMENT_ID are unresolvable.
  const { modelName, deploymentId } = await resolveChatLlmSettings();
```

Keep every existing reference to `modelName` and `deploymentId` downstream — they resolve to the same values.

- [ ] **Step 4: Run tests to verify no regression**

Run: `npx vitest run srv/lib/__tests__/category-classifier-llm.test.js`

Expected: The existing tests may need one adjustment. If they mock `SELECT.one.from(...)` with `{ modelName: null, deploymentId: null }` and expect `classifyViaLlm` to succeed via env fallback, they may now throw (because `resolveChatLlmSettings` throws when `deploymentId` is null and no env var is set). Two options:

- Preferred: adjust the test's `beforeEach` to set `process.env.CHAT_DEPLOYMENT_ID = 'test-deployment'` and add an `afterAll` to `delete process.env.CHAT_DEPLOYMENT_ID`.
- Alternative: mock `chat-settings-resolver.js` at the module boundary via `vi.mock('../chat-settings-resolver.js', () => ({ resolveChatLlmSettings: () => ({ modelName: 'test-model', deploymentId: 'test-dep' }) }));`.

Pick the module-mock approach — it's the pattern the other tests will adopt in Task 3.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run srv/lib/__tests__/category-classifier-llm.test.js`

Expected: All tests pass.

- [ ] **Step 6: Zero-regression grep**

Run: `grep -nE "settings\?\.MODELNAME|CHAT_MODEL_NAME|CHAT_DEPLOYMENT_ID" srv/lib/category-classifier-llm.js`

Expected: NO matches.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/category-classifier-llm.js srv/lib/__tests__/category-classifier-llm.test.js
git commit -m "refactor(#959): category-classifier-llm.js uses resolveChatLlmSettings

Deletes the ~30-line inline resolver block (duplicated from
chat-settings-resolver.js). Test now mocks the resolver at the module
boundary rather than shimming globalThis.SELECT for the resolver's
internal read."
```

---

## Task 3: Rewire `os-variant-generator.js`

**Files:**
- Modify: `srv/lib/os-variant-generator.js`
- Test: `srv/lib/__tests__/os-variant-generator.test.js`

**Interfaces:**
- Consumes: `resolveChatLlmSettings()` from Task 1.
- Produces: no interface changes to `generateOsVariants`.

- [ ] **Step 1: Baseline test run**

Run: `npx vitest run srv/lib/__tests__/os-variant-generator.test.js`

Expected: All existing tests pass.

- [ ] **Step 2: Edit `srv/lib/os-variant-generator.js` — replace inline `resolveSettings()`**

Update imports at the top of `srv/lib/os-variant-generator.js`:

```js
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { persistAuthorAiRequest } from './author-ai-persist.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
```

Delete the local `resolveSettings()` function entirely (currently around lines 55–82 — the whole `async function resolveSettings() { ... }` block including its JSDoc).

Find every call to `resolveSettings()` (grep confirms line 110) and change it to:

```js
const { modelName, deploymentId } = await resolveChatLlmSettings();
```

- [ ] **Step 3: Run tests to verify — expect the same resolver-mock adjustment as Task 2**

Run: `npx vitest run srv/lib/__tests__/os-variant-generator.test.js`

Expected: Test may need `vi.mock('../chat-settings-resolver.js', ...)` added at the top with the same pattern from Task 2 Step 4. Add it if needed:

```js
vi.mock('../chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: () => Promise.resolve({
    modelName: 'anthropic--claude-4.6-sonnet',
    deploymentId: 'test-dep',
  }),
}));
```

- [ ] **Step 4: Verify all tests pass**

Run: `npx vitest run srv/lib/__tests__/os-variant-generator.test.js`

Expected: All tests pass.

- [ ] **Step 5: Zero-regression grep**

Run: `grep -nE "resolveSettings|CHAT_MODEL_NAME|CHAT_DEPLOYMENT_ID|settings\?\.MODELNAME" srv/lib/os-variant-generator.js`

Expected: NO matches.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/os-variant-generator.js srv/lib/__tests__/os-variant-generator.test.js
git commit -m "refactor(#959): os-variant-generator.js uses resolveChatLlmSettings

Deletes the local resolveSettings() function (function-scope duplicate
of chat-settings-resolver.js's resolver). Test mocks the shared
resolver at the module boundary."
```

---

## Task 4: Rewire `explainer-generator.js` (behaviour change: model steer via ChatSettings)

**Files:**
- Modify: `srv/lib/explainer-generator.js`
- Test: check `srv/lib/__tests__/` for an `explainer-generator.test.js`; if none exists, skip test edits — the file is exercised via the admin-service action-handler tests.

**Interfaces:**
- Consumes: `resolveChatLlmSettings()` from Task 1.
- Produces: no interface changes to `generateExplainer`.

- [ ] **Step 1: Check for an existing test file**

Run: `ls srv/lib/__tests__/ | grep -i explainer`

Expected: One of:
- File exists → run it as a baseline (`npx vitest run srv/lib/__tests__/explainer-generator*.test.js`)
- No file → the module is tested indirectly via `test/admin-service-explainer*.test.js` or via the `globalThis.__EXPLAINER_GENERATOR_TEST_IMPL__` short-circuit at line 102 of the current source. Note the indirect test path and continue.

- [ ] **Step 2: Edit `srv/lib/explainer-generator.js` — add resolver import**

Update imports at the top:

```js
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { tokensToCents } from './_token-cost.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
```

- [ ] **Step 3: Delete the `DEFAULT_MODEL` const**

Delete lines 31–36 (the `// Default model. Currently hardcoded ...` comment block and the `const DEFAULT_MODEL = 'anthropic--claude-4.6-sonnet';` line).

- [ ] **Step 4: Rewire the call site — replace `const modelName = DEFAULT_MODEL;` and the `{}` deployment-passthrough**

Locate line 113 (`const modelName = DEFAULT_MODEL;`) and lines 115–133 (the `new OrchestrationClient(...)` block ending with `{} // deploymentId / resourceGroup picked up from cds.requires/env`).

Replace with:

```js
  // Resolve modelName + deploymentId via the shared resolver. Admins can
  // steer the explainer model via /admin-ui/#joule-settings (parity with
  // every other LLM call site in the app). Throws if deploymentId is
  // unresolvable.
  const { modelName, deploymentId } = await resolveChatLlmSettings();

  const client = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: modelName,
          params: {
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            tool_choice: { type: 'function', function: { name: TOOL_NAME } },
          },
        },
        prompt: {
          template: [{ role: 'system', content: systemPrompt }],
          tools: [TOOL_SPEC],
        },
      },
    },
    { deploymentId }
  );
```

- [ ] **Step 5: Verify token-cost rates cover `anthropic--claude-4.6-sonnet`**

Run: `grep -n "anthropic--claude-4.6-sonnet" srv/lib/_token-cost.js`

Expected: The model is in the `RATES` map. If it's missing, add it — but per the current file `RATES` covers it, so this should be a no-op check.

- [ ] **Step 6: Run any explainer tests**

If a test file exists: `npx vitest run srv/lib/__tests__/explainer-generator*.test.js` — expect pass.

If no test file exists: run the admin-service integration tests: `npx vitest run test/admin-service*.test.js` — expect pass (or note pre-existing failures unrelated to this change).

- [ ] **Step 7: Zero-regression grep**

Run: `grep -nE "DEFAULT_MODEL|'anthropic--claude-4.6-sonnet'" srv/lib/explainer-generator.js`

Expected: NO matches.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/explainer-generator.js
git commit -m "refactor(#959): explainer-generator uses ChatSettings.modelName

Behaviour change: admins can now steer the homepage-explainer model
via /admin-ui/#joule-settings, matching every other LLM call site.
Previously the model was hardcoded to 'anthropic--claude-4.6-sonnet'
and only the deploymentId came from env-var passthrough.

Downside: an admin who picks a model missing from _token-cost.js RATES
gets a 'no rates for model X' throw on cost calculation — same failure
mode as every other LLM call today, not a new risk."
```

---

## Task 5: Rewire embedding-model readers in `srv/lib/`

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`
- Modify: `srv/search-service.js`
- (Audit-only, no change expected): `srv/lib/embedding-pipeline.js`, `srv/lib/embedding-query.js`

**Interfaces:**
- Consumes: `resolveEmbeddingSettings()` from Task 1.

- [ ] **Step 1: Audit `embedding-pipeline.js` and `embedding-query.js`**

Run:
```bash
grep -n "embeddingModel" srv/lib/embedding-pipeline.js srv/lib/embedding-query.js
```

Expected: The matches assign to output rows (`embeddingModel: model`) or filter WHERE clauses (`.where({ embeddingModel: model })`) — not reads of `ChatSettings.embeddingModel`. NO changes needed.

- [ ] **Step 2: Edit `srv/lib/chat-orchestrator.js` — `expandSearchConcepts` dispatch**

Locate the `expandSearchConcepts` handler (around line 594). The current block reads:

```js
      let model = 'text-embedding-3-small';
      try {
        const { ChatSettings } = cds.entities('com.sap.developers.ims');
        const row = await SELECT.one.from(ChatSettings).columns('embeddingModel');
        if (row?.embeddingModel) model = row.embeddingModel;
      } catch { /* keep default */ }
```

Add the resolver import at the top of the file. Locate the existing import block (top of file — the `import cds from '@sap/cds'` is line 1):

```js
import { embed as embedInputs } from './embedding-client.js';
```

Add:

```js
import { resolveEmbeddingSettings } from './chat-settings-resolver.js';
```

Then replace the `let model = ... try { ... } catch { ... }` block with:

```js
      // Resolve embedding model via the shared resolver. Failure to read
      // ChatSettings falls back through env → hardcoded default; NEVER throws.
      const { model } = await resolveEmbeddingSettings();
```

- [ ] **Step 3: Edit `srv/search-service.js` — KG signal embedding-model read**

Add resolver import to `srv/search-service.js` imports. Locate the current cluster of imports at the top (imports order is fine wherever they sit):

```js
import { resolveEmbeddingSettings } from './lib/chat-settings-resolver.js';
```

Locate the block around line 218–232 (the `readChatSettings()` call and `embeddingModel: settings.embeddingModel || 'text-embedding-3-small'`).

Replace:
```js
        if (settings?.searchKgRerankEnabled) {
          const signal = await computeKgSignal({
            phrase,
            db: cds.db,
            embeddingModel: settings.embeddingModel || 'text-embedding-3-small',
            enabled: true,
          });
```

With:
```js
        if (settings?.searchKgRerankEnabled) {
          const { model: embeddingModel } = await resolveEmbeddingSettings();
          const signal = await computeKgSignal({
            phrase,
            db: cds.db,
            embeddingModel,
            enabled: true,
          });
```

Rationale: the resolver reads ChatSettings itself (via `readChatSettings()`), so the extra DB round-trip is redundant IF the outer `readChatSettings()` in `search-service.js` already returned the row. But the extraction keeps the fallback chain consistent — the resolver knows about env fallback + hardcoded default that the inline `|| 'text-embedding-3-small'` doesn't. If performance profiling ever flags the double-read, the caller can pass its ChatSettings row through — but not now (YAGNI).

- [ ] **Step 4: Run relevant tests**

Run: `npx vitest run srv/lib/__tests__/ test/search-service*.test.{js,ts}`

Expected: All tests pass. If a search-service test mocks `readChatSettings` and `expects` the inline `text-embedding-3-small` string on a specific path, adjust the test to mock `resolveEmbeddingSettings` too.

- [ ] **Step 5: Zero-regression grep — `srv/lib/` + `srv/search-service.js`**

Run:
```bash
grep -rn "'text-embedding-3-small'" srv/lib/ srv/search-service.js srv/chat-service.js
```

Expected: The only match is in `srv/lib/chat-settings-resolver.js` (the fallback const).

Run:
```bash
grep -rn "ChatSettings.*embeddingModel\|embeddingModel.*ChatSettings" srv/lib/ srv/search-service.js srv/chat-service.js
```

Expected: NO matches in these files after the refactor. (Job files under `srv/jobs/` are Task 6.)

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js srv/search-service.js
git commit -m "refactor(#959): srv/lib embedding readers use resolveEmbeddingSettings

Two call sites — chat-orchestrator.js's expandSearchConcepts dispatch
and search-service.js's KG-rerank signal — now go through the shared
resolver instead of doing their own SELECT.one.from(ChatSettings)
+ '|| text-embedding-3-small' fallback.

The extra DB round-trip inside the resolver is measurable but
negligible for these paths (both already do at least one settings
read on the outer scope). YAGNI on threading a settings row through."
```

---

## Task 6: Rewire embedding-model readers in `srv/jobs/`

**Files:**
- Modify: `srv/jobs/concept-embedding-backfill.js`
- Modify: `srv/jobs/fetch-api-docs-job.js`
- Modify: `srv/jobs/fetch-blog-posts-job.js`
- Modify: `srv/jobs/fetch-community-events-job.js`
- Modify: `srv/jobs/fetch-discovery-missions-job.js`
- Modify: `srv/jobs/fetch-help-docs-job.js`
- Modify: `srv/jobs/fetch-learning-journeys-job.js`
- Modify: `srv/jobs/fetch-samples-job.js`
- Modify: `srv/jobs/fetch-videos-job.js`

**Interfaces:**
- Consumes: `resolveEmbeddingSettings()` from Task 1.

- [ ] **Step 1: Audit each job to see the exact inline pattern**

Run:
```bash
for f in srv/jobs/concept-embedding-backfill.js srv/jobs/fetch-api-docs-job.js srv/jobs/fetch-blog-posts-job.js srv/jobs/fetch-community-events-job.js srv/jobs/fetch-discovery-missions-job.js srv/jobs/fetch-help-docs-job.js srv/jobs/fetch-learning-journeys-job.js srv/jobs/fetch-samples-job.js srv/jobs/fetch-videos-job.js; do
  echo "===== $f ====="
  grep -n -B1 -A3 "embeddingModel" "$f"
done
```

Expected: Each file has one `SELECT.one.from(ChatSettings).columns('embeddingModel')` read and one immediate use of the returned `embeddingModel` field. Note the exact variable name (`cfg`, `row`, `settings`) each file uses — it varies.

- [ ] **Step 2: For each job file, add the resolver import**

For each of the 9 files, add near the top (after `import cds from '@sap/cds'`):

```js
import { resolveEmbeddingSettings } from '../lib/chat-settings-resolver.js';
```

- [ ] **Step 3: For each job file, replace the ChatSettings read with a resolver call**

The pattern varies slightly per file, but always looks like:

```js
const cfg = await SELECT.one.from(ChatSettings).columns('embeddingModel');
const model = cfg?.embeddingModel || 'text-embedding-3-small';
```

Replace with:

```js
const { model } = await resolveEmbeddingSettings();
```

Grep the file to find every downstream use of the variable — some files reassign, some pass through. Preserve variable names by using destructuring aliases if the file already binds to `embeddingModel` locally:

```js
const { model: embeddingModel } = await resolveEmbeddingSettings();
```

Do NOT delete the `const { ChatSettings } = cds.entities('com.sap.developers.ims');` line if the file uses `ChatSettings` for other purposes (some read multiple columns). Grep first, then decide.

- [ ] **Step 4: Run job-related tests**

Run: `npx vitest run test/jobs/`

Expected: All tests pass. Adjust any test that mocks `SELECT.one.from(ChatSettings)` to instead mock `resolveEmbeddingSettings` at the module boundary:

```js
vi.mock('../../srv/lib/chat-settings-resolver.js', () => ({
  resolveEmbeddingSettings: () => Promise.resolve({ model: 'text-embedding-3-small' }),
}));
```

- [ ] **Step 5: Zero-regression grep — `srv/jobs/`**

Run:
```bash
grep -rnE "'text-embedding-3-small'|ChatSettings.*embeddingModel|embeddingModel.*ChatSettings" srv/jobs/
```

Expected: NO matches (the only remaining hardcoded default lives in `srv/lib/chat-settings-resolver.js`).

- [ ] **Step 6: Run full unit suite**

Run: `npm test`

Expected: All tests pass. If a test in an unrelated area fails, it's likely pre-existing — check `main` branch.

- [ ] **Step 7: Commit**

```bash
git add srv/jobs/
git commit -m "refactor(#959): 9 srv/jobs embedding readers use resolveEmbeddingSettings

concept-embedding-backfill + 8 fetch-*-job files replace their inline
SELECT.one.from(ChatSettings).columns('embeddingModel') + fallback
literal with a single resolveEmbeddingSettings() call.

Zero-regression grep confirms 'text-embedding-3-small' now lives ONLY
in srv/lib/chat-settings-resolver.js as the fallback default."
```

---

## Task 7: Final zero-regression sweep + PR-ready polish

**Files:**
- None modified (verification only)

- [ ] **Step 1: Global zero-regression grep**

Run:
```bash
grep -rnE "settings\?\.MODELNAME|settings\?\.DEPLOYMENTID|CHAT_MODEL_NAME|CHAT_DEPLOYMENT_ID|CHAT_EMBEDDING_MODEL" srv/ scripts/
```

Expected: The ONLY matches are:
- `srv/lib/chat-settings-resolver.js` (defines the fallbacks)
- The new test file `srv/lib/__tests__/chat-settings-resolver.test.js` (sets/unsets the env vars)

Any other match is a leftover — fix before opening the PR.

Run:
```bash
grep -rn "'text-embedding-3-small'\|'anthropic--claude-4.6-sonnet'" srv/ scripts/
```

Expected: Both literals appear ONLY in `srv/lib/chat-settings-resolver.js` + its test file. `_token-cost.js` may also have `'anthropic--claude-4.6-sonnet'` as a rate key — that's fine (rates, not fallback).

- [ ] **Step 2: Run all unit tests**

Run: `npm test`

Expected: Green.

- [ ] **Step 3: Local hybrid smoke — verify against real HANA**

Skip if not logged into CF DEV. If logged in:

```bash
cf target -o tutorial-system -s dev
npx cds bind --exec -- npx vitest run test/hybrid/duplicate-slugs.test.js
```

Expected: Passes. This isn't AI-specific — it's a shortest-path hybrid test that verifies cds/HANA connectivity. If the AI paths broke boot, this would fail too.

- [ ] **Step 4: Verify branch state and push**

```bash
git branch --show-current
# expected: worktree-959-cap-ai-improvements

git log --oneline main..HEAD
# expected: 7 commits — spec + 6 refactor commits
```

- [ ] **Step 5: Open the draft PR**

```bash
git push -u origin worktree-959-cap-ai-improvements

gh pr create --draft --title "refactor(#959): consolidate AI configuration resolution (PR 1 of 2)" --body "Part 1 of the CAP 10 AI improvements split from #959. See docs/superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md for context.

## What changed

- Extract \`readChatSettings()\` helper in \`srv/lib/chat-settings-resolver.js\`.
- Add \`resolveEmbeddingSettings()\` export (returns \`{ model }\`).
- Rewire 2 inline resolver duplicates (\`category-classifier-llm.js\`, \`os-variant-generator.js\`).
- Rewire 9 embedding-model readers in \`srv/jobs/\` and 2 in \`srv/\` to use the shared resolver.
- **Behaviour change**: \`explainer-generator.js\` now uses \`ChatSettings.modelName\` (matches every other LLM call site).

## Zero regression

- No schema, no dep, no MTA changes.
- Grep confirms these tokens live ONLY in \`chat-settings-resolver.js\`: \`settings?.MODELNAME\`, \`CHAT_MODEL_NAME\`, \`CHAT_DEPLOYMENT_ID\`, \`CHAT_EMBEDDING_MODEL\`, \`'text-embedding-3-small'\`, \`'anthropic--claude-4.6-sonnet'\`.
- 8 new unit tests + all existing tests green.

## Follow-up

PR 2 adopts \`@cap-js/ai\` for \`@Common.ValueList\` recommendations (separate branch)."
```

- [ ] **Step 6: Report ship state**

Verify: `gh pr view --json url,state,isDraft | jq`

Expected: A draft PR opened, state OPEN. Note the URL.

---

## Self-Review

**Spec coverage check** (against `docs/superpowers/specs/2026-07-04-959-cap-ai-plugin-adoption-design.md` § "PR 1"):

| Spec item | Covered by task |
|-----------|-----------------|
| Extract `readChatSettings()` helper | Task 1 Step 7 |
| Add `resolveEmbeddingSettings()` | Task 1 Step 7 |
| Rewire `category-classifier-llm.js` | Task 2 |
| Rewire `os-variant-generator.js` | Task 3 |
| Rewire `explainer-generator.js` (behaviour change accepted) | Task 4 |
| `embedding-client.js` — no signature change | Task 5 Step 1 (audit-only) |
| Rewire chat-orchestrator embedding read | Task 5 Step 2 |
| Rewire embedding-query, embedding-pipeline (audit only) | Task 5 Step 1 |
| Rewire 9 `srv/jobs/` embedding readers | Task 6 |
| Rewire `srv/search-service.js` embedding read (found in probe) | Task 5 Step 3 |
| `chat-orchestrator.js` `streamChat()` unchanged | Task 5 (constraint, no code path touched) |
| Zero-regression grep constraint | Task 7 Step 1 |
| Unit tests for resolver (8 cases) | Task 1 Steps 1, 3, 5 |

**Placeholder scan**: No TBD, TODO, or "similar to earlier task" — every step has explicit code or command.

**Type consistency**: `resolveChatLlmSettings() → { modelName, deploymentId }` and `resolveEmbeddingSettings() → { model }` used consistently across all tasks.
