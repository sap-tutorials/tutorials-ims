# KG Communities in Joule — "what to learn next" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Joule a `findCommunityPeers` tool that surfaces a coherent themed set of sibling tutorials from the same Louvain community, labeled with a human-readable LLM-generated cluster name, plus the PROD rollout of the #917 nightly community-detection job that feeds it.

**Architecture:** Three layers land in one PR, staged dark→live. (1) A new `KgCommunityLabel` sidecar + nightly labeling job that LLM-names each community keyed on its stable fingerprint. (2) A `findCommunityPeers` Joule tool gated behind a new `communityPeersEnabled` ChatSettings flag (default OFF), cloning the #1125 `findRelatedContent` template end-to-end (descriptor → registry → dispatch → SSE → joule.js frame). (3) PROD enablement of the existing Louvain job (config/verification, no job-code change).

**Tech Stack:** SAP CAP (Node.js, cds10), SAP HANA Cloud, `@sap-ai-sdk/orchestration` (OrchestrationClient.chatCompletion), Vitest, Hugo static JS.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-12-1126-kg-communities-joule-design.md` (companion to this plan).
- **Slugs are lowercase canonical** — always `.toLowerCase()` before comparing a slug to DB data.
- **Community identity keys off `communityFingerprint` (String(64)), never the volatile `communityId`.**
- **Never SELECT a HANA BLOB alongside metadata via CDS QL** — N/A here (all columns scalar), but no BLOB columns may be added to these entities.
- **HANA stores unquoted `.hdbtable` identifiers UPPER-CASE** — raw SQL against `KgCommunity`/`ChatSettings`/`Tutorials` uses quoted-uppercase names (`"COMMUNITYFINGERPRINT"`), matching `srv/jobs/kg-communities-job.js:89`.
- **After any `db/**/*.cds` change:** run `cds build --production` (regenerate `db/last-dev/csn.json`) AND `npx cds deploy --to sqlite::memory:` before committing — `cds compile` alone misses runtime/deploy errors.
- **`.hdbmigrationtable` must be hand-edited in lockstep** with `db/schema.cds` ChatSettings changes: bump `== version=` header, add columns to the `COLUMN TABLE` body, add a new `== migration=N` `ALTER TABLE` block.
- **No CSV seed** for `KgCommunityLabel` — it is job-written; an `.hdbtabledata` would clobber generated values on every hash-changing redeploy.
- **New `srv/lib/**` runtime imports must be direct prod deps** in `package.json` (CF prunes devDeps) AND, if imported transitively from `srv/lib/content-store.js`, present in `.deploy/mta.yaml`'s `srv-qa` `cp` list. This plan adds no new npm deps (`@sap-ai-sdk/orchestration` and `node:crypto` already present).
- **Fail-open everywhere:** no bare `catch { return null }` — log via `cds.log(...)` and return a safe empty shape.
- **Run tests with `--project hybrid` for hybrid runs** (bare `vitest <file>` skips hybrid setup).
- **Commit frequently; each task ends green.**

---

### Task 1: `KgCommunityLabel` sidecar entity

**Files:**
- Modify: `db/knowledge-graph-communities.cds` (append after `KgCommunitySummaryV`, line 64)
- Test: `test/unit/kg/kg-community-label-entity.test.js` (create)

**Interfaces:**
- Produces: entity `com.sap.developers.ims.KgCommunityLabel` with key `communityFingerprint : String(64)` and fields `label : String(120)`, `rationale : String(500)`, `memberSlugsHash : String(64)`, `labeledAt : Timestamp`, `model : String(100)`. HANA table `COM_SAP_DEVELOPERS_IMS_KGCOMMUNITYLABEL`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/kg-community-label-entity.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

describe('KgCommunityLabel entity', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(path.join(process.cwd(), 'db'));
  });

  it('is defined with communityFingerprint as the sole key', () => {
    const e = model.definitions['com.sap.developers.ims.KgCommunityLabel'];
    expect(e).toBeTruthy();
    expect(e.kind).toBe('entity');
    const keys = Object.entries(e.elements).filter(([, el]) => el.key).map(([n]) => n);
    expect(keys).toEqual(['communityFingerprint']);
    expect(e.elements.communityFingerprint.length).toBe(64);
    expect(e.elements.label.length).toBe(120);
    expect(e.elements.memberSlugsHash.length).toBe(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/kg-community-label-entity.test.js`
Expected: FAIL — `expect(e).toBeTruthy()` receives `undefined`.

- [ ] **Step 3: Add the entity**

Append to `db/knowledge-graph-communities.cds` (after line 64):

```cds

// KgCommunityLabel — human-readable label per community (#1126). Keyed on the
// stable communityFingerprint (#985), NOT the volatile Louvain communityId, so
// a label survives nightly re-runs as long as the tutorial membership is
// unchanged. Written by srv/jobs/kg-community-label-job.js; never CSV-seeded
// (a .hdbtabledata would clobber generated values on redeploy).
//
// memberSlugsHash is the skip-key: the fingerprint hashes only tutorial-typed
// slugs, but the label reflects the whole cluster, so the job re-labels only
// when the full sorted member-slug set changes.
@cds.autoexpose: false
entity KgCommunityLabel {
  key communityFingerprint : String(64);
      label                : String(120);
      rationale            : String(500);
      memberSlugsHash      : String(64);
      labeledAt            : Timestamp;
      model                : String(100);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/kg-community-label-entity.test.js`
Expected: PASS.

- [ ] **Step 5: Regenerate production build + verify deploy**

Run: `npx cds build --production && npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: build succeeds, `db/last-dev/csn.json` updated, deploy prints `/> successfully deployed to in-memory database` (no UNIQUE/assert errors).

- [ ] **Step 6: Commit**

```bash
git add db/knowledge-graph-communities.cds db/last-dev/csn.json test/unit/kg/kg-community-label-entity.test.js
git commit -m "feat(kg): KgCommunityLabel sidecar entity (#1126)"
```

---

### Task 2: `ChatSettings` flag + LLM-budget columns

**Files:**
- Modify: `db/schema.cds:662` (after `kgRelatedContentEnabled`, inside `ChatSettings`)
- Modify: `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable` (version bump + body + new migration block)
- Test: `test/unit/kg/chat-settings-community-flag.test.js` (create)

**Interfaces:**
- Produces: `ChatSettings.communityPeersEnabled : Boolean default false`, `communityLabelLlmBudgetPerDay : Integer default 50`, `communityLabelLlmCallsToday : Integer default 0`, `communityLabelLlmCallsCountedOn : Date`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/chat-settings-community-flag.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

describe('ChatSettings community columns (#1126)', () => {
  let cs;
  beforeAll(async () => {
    const model = await cds.load(path.join(process.cwd(), 'db'));
    cs = model.definitions['com.sap.developers.ims.ChatSettings'];
  });

  it('adds communityPeersEnabled defaulting false', () => {
    expect(cs.elements.communityPeersEnabled.type).toBe('cds.Boolean');
    expect(cs.elements.communityPeersEnabled.default.val).toBe(false);
  });

  it('adds the LLM budget triplet', () => {
    expect(cs.elements.communityLabelLlmBudgetPerDay.default.val).toBe(50);
    expect(cs.elements.communityLabelLlmCallsToday.default.val).toBe(0);
    expect(cs.elements.communityLabelLlmCallsCountedOn.type).toBe('cds.Date');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/chat-settings-community-flag.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'type')`.

- [ ] **Step 3: Add CDS columns**

In `db/schema.cds`, immediately after line 662 (`kgRelatedContentEnabled : Boolean default true;`), before the `newsRelevance…` block:

```cds

  // Community-peers Joule tool (#1126). Default OFF — depends on the PROD
  // Louvain rollout + nightly labeling being live, so it ships dark and is
  // flipped on after PROD KgCommunity/KgCommunityLabel data is verified.
  communityPeersEnabled           : Boolean default false;

  // Daily LLM budget for kg-community-label-job (#1126). Mirrors the
  // newsRelevance… counter pattern so a first-run backlog of new community
  // fingerprints ramps over a few nights rather than spiking AI Core spend.
  communityLabelLlmBudgetPerDay   : Integer default 50;
  communityLabelLlmCallsToday     : Integer default 0;
  communityLabelLlmCallsCountedOn : Date;
```

- [ ] **Step 4: Hand-edit the migration table**

In `db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable`:
1. Change line 1 header from `== version=12` to `== version=13`.
2. Add these four lines to the `COLUMN TABLE` body, after line 30 (`newsRelevanceLlmCallsCountedOn DATE,`) and before `PRIMARY KEY(ID)`:

```sql
  communityPeersEnabled BOOLEAN DEFAULT FALSE,
  communityLabelLlmBudgetPerDay INTEGER DEFAULT 50,
  communityLabelLlmCallsToday INTEGER DEFAULT 0,
  communityLabelLlmCallsCountedOn DATE,
```

3. Insert a new migration block immediately after line 33 (the blank line after the `COLUMN TABLE` closing `)`), above `== migration=12`:

```sql
== migration=13
ALTER TABLE com_sap_developers_ims_ChatSettings ADD (communityPeersEnabled BOOLEAN DEFAULT FALSE, communityLabelLlmBudgetPerDay INTEGER DEFAULT 50, communityLabelLlmCallsToday INTEGER DEFAULT 0, communityLabelLlmCallsCountedOn DATE);
```

- [ ] **Step 5: Run test + verify build**

Run: `npx vitest run test/unit/kg/chat-settings-community-flag.test.js && npx cds build --production && npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: test PASS, build OK, in-memory deploy OK.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/src/com.sap.developers.ims.ChatSettings.hdbmigrationtable db/last-dev/csn.json test/unit/kg/chat-settings-community-flag.test.js
git commit -m "feat(kg): ChatSettings communityPeersEnabled flag + label LLM budget (#1126)"
```

---

### Task 3: Community-labeling LLM caller

**Files:**
- Create: `srv/lib/kg/community-label-llm.js`
- Test: `test/unit/kg/community-label-llm.test.js`

**Interfaces:**
- Consumes: `resolveChatLlmSettings()` from `srv/lib/chat-settings-resolver.js`; `OrchestrationClient` from `@sap-ai-sdk/orchestration`.
- Produces: `export async function labelCommunityViaLlm({ tutorialTitles, conceptNames }) => Promise<{ label: string, rationale: string, modelName: string }>`. Throws `Error /no tool call/i` if the model returns no forced tool call.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/community-label-llm.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatCompletion = vi.fn();
vi.mock('@sap-ai-sdk/orchestration', () => ({
  OrchestrationClient: vi.fn().mockImplementation(() => ({ chatCompletion })),
}));
vi.mock('../../../srv/lib/chat-settings-resolver.js', () => ({
  resolveChatLlmSettings: vi.fn().mockResolvedValue({ modelName: 'm1', deploymentId: 'd1' }),
}));

import { labelCommunityViaLlm } from '../../../srv/lib/kg/community-label-llm.js';

describe('labelCommunityViaLlm', () => {
  beforeEach(() => chatCompletion.mockReset());

  it('returns the forced tool-call label + rationale', async () => {
    chatCompletion.mockResolvedValue({
      getToolCalls: () => [{ function: { arguments: JSON.stringify({ label: 'SAP RAP & Fiori Elements', rationale: 'Clustered RAP + FE tutorials.' }) } }],
      getTokenUsage: () => null,
    });
    const out = await labelCommunityViaLlm({
      tutorialTitles: ['Build a RAP app', 'Create a Fiori Elements UI'],
      conceptNames: ['RAP', 'Fiori Elements'],
    });
    expect(out.label).toBe('SAP RAP & Fiori Elements');
    expect(out.rationale).toContain('RAP');
    expect(out.modelName).toBe('m1');
  });

  it('throws when the model returns no tool call', async () => {
    chatCompletion.mockResolvedValue({ getToolCalls: () => [] });
    await expect(labelCommunityViaLlm({ tutorialTitles: ['x'], conceptNames: [] }))
      .rejects.toThrow(/no tool call/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-label-llm.test.js`
Expected: FAIL — cannot resolve `srv/lib/kg/community-label-llm.js`.

- [ ] **Step 3: Implement the caller** (mirrors `srv/lib/category-classifier-llm.js`)

```javascript
// srv/lib/kg/community-label-llm.js
// Forced-tool-call LLM wrapper that names a KG community (#1126).
// Mirrors srv/lib/category-classifier-llm.js: single non-streaming round-trip,
// tool_choice forces the model to return a structured { label, rationale }.

import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { resolveChatLlmSettings } from '../chat-settings-resolver.js';

const LOG = cds.log('kg-community-label-llm');
const TOOL_NAME = 'submit_community_label';
const TEMPERATURE = 0.2;   // slight room for a natural name, still near-deterministic
const MAX_TOKENS = 256;

const LABEL_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit a short human-readable label and one-line rationale for a cluster of related SAP tutorials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'rationale'],
      properties: {
        label: { type: 'string', description: 'A concise topic label, at most 6 words (e.g. "SAP RAP & Fiori Elements").' },
        rationale: { type: 'string', description: 'One sentence explaining what ties the cluster together.' },
      },
    },
  },
};

/**
 * @param {object} opts
 * @param {string[]} opts.tutorialTitles - Member tutorial titles (drives the label).
 * @param {string[]} opts.conceptNames   - Top concept names for extra context (may be empty).
 * @returns {Promise<{label:string, rationale:string, modelName:string}>}
 * @throws {Error} matching /no tool call/i if the model returns no tool call.
 */
export async function labelCommunityViaLlm({ tutorialTitles, conceptNames }) {
  const { modelName, deploymentId } = await resolveChatLlmSettings();

  const systemPrompt = [
    'You name clusters of related SAP developer tutorials for learners.',
    'Given the tutorial titles (and optional concepts) in one cluster, produce a short,',
    'human-readable topic label (<=6 words) and a one-sentence rationale.',
    'Rules:',
    '- The label names the shared theme, not any single tutorial.',
    '- No trailing punctuation on the label.',
    '- You MUST call the submit_community_label tool to return your answer.',
  ].join('\n');

  const userPrompt = [
    'Tutorial titles:',
    ...(tutorialTitles || []).map((t) => `- ${t}`),
    '',
    'Concepts:',
    (conceptNames && conceptNames.length) ? conceptNames.join(', ') : '(none)',
  ].join('\n');

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
        prompt: { template: [{ role: 'system', content: systemPrompt }], tools: [LABEL_TOOL] },
      },
    },
    { deploymentId }
  );

  const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: userPrompt }] });

  const toolCalls = response.getToolCalls?.();
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    LOG.warn('community-label LLM returned no tool call');
    throw new Error('labelCommunityViaLlm: no tool call returned by model');
  }

  const rawArgs = toolCalls[0].function?.arguments;
  let parsed;
  try {
    parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch (parseErr) {
    throw new Error(`labelCommunityViaLlm: failed to parse tool call arguments: ${parseErr.message}`);
  }

  const label = String(parsed.label ?? '').trim().slice(0, 120);
  const rationale = String(parsed.rationale ?? '').trim().slice(0, 500);
  if (!label) throw new Error('labelCommunityViaLlm: model returned empty label');

  return { label, rationale, modelName };
}

export default { labelCommunityViaLlm };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-label-llm.test.js`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/community-label-llm.js test/unit/kg/community-label-llm.test.js
git commit -m "feat(kg): community-label LLM caller (forced tool-call) (#1126)"
```

---

### Task 4: Member-slug hashing helper

**Files:**
- Create: `srv/lib/kg/community-member-hash.js`
- Test: `test/unit/kg/community-member-hash.test.js`

**Interfaces:**
- Produces: `export function computeMemberSlugsHash(slugs: string[]) => string` — SHA-256 hex over the sorted, de-duplicated, non-empty slug list joined with `'\n'`. Returns the empty-input sentinel `''` for an empty/all-empty list (caller skips those communities).

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/community-member-hash.test.js
import { describe, it, expect } from 'vitest';
import { computeMemberSlugsHash } from '../../../srv/lib/kg/community-member-hash.js';

describe('computeMemberSlugsHash', () => {
  it('is order-independent and de-duplicates', () => {
    expect(computeMemberSlugsHash(['b', 'a', 'b'])).toBe(computeMemberSlugsHash(['a', 'b']));
  });
  it('changes when a member is added', () => {
    expect(computeMemberSlugsHash(['a', 'b'])).not.toBe(computeMemberSlugsHash(['a', 'b', 'c']));
  });
  it('returns empty-string sentinel for no usable slugs', () => {
    expect(computeMemberSlugsHash([])).toBe('');
    expect(computeMemberSlugsHash([null, ''])).toBe('');
  });
  it('produces 64-char hex for a real list', () => {
    expect(computeMemberSlugsHash(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-member-hash.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// srv/lib/kg/community-member-hash.js
// Skip-key hash for community labeling (#1126). Distinct from
// kg-community-fingerprint.js (tutorial-typed slugs only): this hashes the
// FULL member-slug set (tutorials + concepts + tags + …) so the labeling job
// re-labels when non-tutorial members change too.

import crypto from 'node:crypto';

/**
 * @param {ReadonlyArray<string>} slugs - any-typed member slugs (may contain nulls/dups).
 * @returns {string} 64-char lowercase hex, or '' when no usable slug is present.
 */
export function computeMemberSlugsHash(slugs) {
  if (!Array.isArray(slugs)) return '';
  const clean = [...new Set(slugs.filter((s) => typeof s === 'string' && s.length > 0))].sort();
  if (clean.length === 0) return '';
  return crypto.createHash('sha256').update(clean.join('\n')).digest('hex');
}

export default { computeMemberSlugsHash };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-member-hash.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/community-member-hash.js test/unit/kg/community-member-hash.test.js
git commit -m "feat(kg): full-member-set skip-key hash for community labeling (#1126)"
```

---

### Task 5: Nightly community-labeling job

**Files:**
- Create: `srv/jobs/kg-community-label-job.js`
- Test: `test/unit/kg/kg-community-label-job.test.js`

**Interfaces:**
- Consumes: `labelCommunityViaLlm` (Task 3), `computeMemberSlugsHash` (Task 4), `KgCommunity`/`KgCommunityLabel`/`ChatSettings` entities.
- Produces: `export async function runKgCommunityLabels() => Promise<{ labeled: number, skipped: number, budgetHit: boolean, failures: number }>`. Default export `{ runKgCommunityLabels }`.

**Logic (implemented in Step 3):** read `KgCommunitySummaryV` rows with `tutorialCount >= 2`; for each, load its member slugs from `KgCommunity`, compute `memberSlugsHash`; skip when an existing `KgCommunityLabel.memberSlugsHash` matches; else, within the daily budget, load member tutorial titles + top concept names, call `labelCommunityViaLlm`, upsert `KgCommunityLabel` on `communityFingerprint`. Per-community try/catch (fail-open); budget counter on `ChatSettings` reset per UTC day.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/kg-community-label-job.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const labelCommunityViaLlm = vi.fn();
vi.mock('../../../srv/lib/kg/community-label-llm.js', () => ({ labelCommunityViaLlm }));

// In-memory fake db keyed by entity name; enough for the job's query shapes.
function makeFakeDb({ summary, members, labels, titles, concepts, settings }) {
  const upserts = [];
  const db = {
    _upserts: upserts,
    async run(q) {
      // The job uses cds.ql SELECT objects; we branch on a tagged _kind we set below.
      if (typeof q === 'function') return q();
      return [];
    },
  };
  return { db, upserts };
}

import { runKgCommunityLabels, _computeForTest } from '../../../srv/jobs/kg-community-label-job.js';

describe('runKgCommunityLabels (pure planner)', () => {
  beforeEach(() => labelCommunityViaLlm.mockReset());

  it('skips communities whose memberSlugsHash is unchanged', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 3 }],
      membersByFp: { fp1: ['a', 'b', 'c'] },
      existingLabels: { fp1: { memberSlugsHash: hashOf(['a', 'b', 'c']) } },
    });
    expect(plan.toLabel).toHaveLength(0);
    expect(plan.skipped).toBe(1);
  });

  it('labels new/changed communities', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 2 }],
      membersByFp: { fp1: ['a', 'b'] },
      existingLabels: {},
    });
    expect(plan.toLabel.map((c) => c.communityFingerprint)).toEqual(['fp1']);
  });

  it('ignores communities with fewer than 2 tutorials', () => {
    const plan = _computeForTest({
      summaries: [{ communityFingerprint: 'fp1', tutorialCount: 1 }],
      membersByFp: { fp1: ['a'] },
      existingLabels: {},
    });
    expect(plan.toLabel).toHaveLength(0);
  });
});

// Local mirror of computeMemberSlugsHash for the assertion.
import { computeMemberSlugsHash as hashOf } from '../../../srv/lib/kg/community-member-hash.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/kg-community-label-job.test.js`
Expected: FAIL — `_computeForTest` / module not found.

- [ ] **Step 3: Implement the job** (pure planner `_computeForTest` + DB-driven `runKgCommunityLabels`)

```javascript
// srv/jobs/kg-community-label-job.js
// Nightly community-labeling job (#1126). Runs ~04:12 UTC, after Louvain
// (03:57) populates KgCommunity. LLM-names each community with >=2 tutorial
// members, keyed on the stable communityFingerprint. Skips communities whose
// full member set is unchanged (memberSlugsHash match) so nightly LLM spend is
// near-zero on stable clusters; a daily budget on ChatSettings ramps a first-run
// backlog over several nights. Fail-open per community; overall throw -> the
// scheduler chassis writes PipelineLog FAILED.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';
import { computeMemberSlugsHash } from '../lib/kg/community-member-hash.js';
import { labelCommunityViaLlm } from '../lib/kg/community-label-llm.js';

const LOG = cds.log('kg-community-label');
const NS = 'com.sap.developers.ims';
const MIN_TUTORIALS = 2;

/**
 * Pure planner — decides which communities need labeling. Unit-testable
 * without a DB. Exported for tests only.
 * @param {object} inp
 * @param {Array<{communityFingerprint:string, tutorialCount:number}>} inp.summaries
 * @param {Record<string,string[]>} inp.membersByFp - fingerprint -> full member slug list
 * @param {Record<string,{memberSlugsHash:string}>} inp.existingLabels
 * @returns {{ toLabel: Array<{communityFingerprint:string, memberSlugsHash:string}>, skipped:number }}
 */
export function _computeForTest({ summaries, membersByFp, existingLabels }) {
  const toLabel = [];
  let skipped = 0;
  for (const s of summaries) {
    if (!s.communityFingerprint || (s.tutorialCount ?? 0) < MIN_TUTORIALS) continue;
    const hash = computeMemberSlugsHash(membersByFp[s.communityFingerprint] || []);
    if (!hash) continue;
    const existing = existingLabels[s.communityFingerprint];
    if (existing && existing.memberSlugsHash === hash) { skipped++; continue; }
    toLabel.push({ communityFingerprint: s.communityFingerprint, memberSlugsHash: hash });
  }
  return { toLabel, skipped };
}

export async function runKgCommunityLabels() {
  const started = Date.now();
  const db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, KgCommunitySummaryV, ChatSettings, Tutorials, Concepts, TutorialConceptLinks } = cds.entities(NS);

  // Budget: reset per UTC day.
  const settings = await SELECT.one.from(ChatSettings);
  const budget = settings?.communityLabelLlmBudgetPerDay ?? 50;
  const today = new Date().toISOString().slice(0, 10);
  let callsToday = settings?.communityLabelLlmCallsCountedOn === today ? (settings.communityLabelLlmCallsToday ?? 0) : 0;

  // Load summaries + all memberships once.
  const summaries = await SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount');
  const allMembers = await SELECT.from(KgCommunity).columns('communityFingerprint', 'vertexType', 'slug');
  const existingRows = await SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'memberSlugsHash');

  const membersByFp = {};
  const tutorialSlugsByFp = {};
  for (const m of allMembers) {
    if (!m.communityFingerprint || !m.slug) continue;
    (membersByFp[m.communityFingerprint] ||= []).push(m.slug);
    if (m.vertexType === 'tutorial') (tutorialSlugsByFp[m.communityFingerprint] ||= []).push(m.slug);
  }
  const existingLabels = Object.fromEntries(existingRows.map((r) => [r.communityFingerprint, r]));

  const { toLabel, skipped } = _computeForTest({ summaries, membersByFp, existingLabels });

  let labeled = 0, failures = 0, budgetHit = false;
  for (const c of toLabel) {
    if (callsToday >= budget) { budgetHit = true; break; }
    try {
      const tutSlugs = (tutorialSlugsByFp[c.communityFingerprint] || []).map((s) => s.toLowerCase());
      const titleRows = tutSlugs.length
        ? await SELECT.from(Tutorials).columns('title').where({ slug: { in: tutSlugs } })
        : [];
      const conceptSlugs = (membersByFp[c.communityFingerprint] || [])
        .filter((s) => !tutSlugs.includes(s.toLowerCase()));
      const conceptRows = conceptSlugs.length
        ? await SELECT.from(Concepts).columns('name').where({ slug: { in: conceptSlugs } }).limit(10)
        : [];

      const { label, rationale, modelName } = await labelCommunityViaLlm({
        tutorialTitles: titleRows.map((r) => r.title).filter(Boolean),
        conceptNames: conceptRows.map((r) => r.name).filter(Boolean),
      });
      callsToday++;

      // Upsert on communityFingerprint (SELECT-then-UPDATE-or-INSERT).
      const exists = existingLabels[c.communityFingerprint];
      const row = { communityFingerprint: c.communityFingerprint, label, rationale, memberSlugsHash: c.memberSlugsHash, labeledAt: new Date().toISOString(), model: modelName };
      if (exists) await UPDATE(KgCommunityLabel).set(row).where({ communityFingerprint: c.communityFingerprint });
      else await INSERT.into(KgCommunityLabel).entries(row);
      labeled++;
    } catch (err) {
      failures++;
      LOG.warn(`[kg-community-label] fingerprint=${c.communityFingerprint} failed:`, err.message);
    }
  }

  // Persist budget counter.
  if (settings?.ID) {
    await UPDATE(ChatSettings).set({ communityLabelLlmCallsToday: callsToday, communityLabelLlmCallsCountedOn: today }).where({ ID: settings.ID });
  }

  const durationMs = Date.now() - started;
  metrics.observe('kg_community_label_duration_ms', durationMs);
  metrics.gauge('kg_community_label_labeled', labeled);
  metrics.gauge('kg_community_label_skipped', skipped);
  if (failures) metrics.counter('kg_community_label_failures', failures);
  LOG.info(`[kg-community-label] labeled=${labeled} skipped=${skipped} failures=${failures} budgetHit=${budgetHit} in ${durationMs}ms`);

  return { labeled, skipped, budgetHit, failures };
}

export default { runKgCommunityLabels };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/kg-community-label-job.test.js`
Expected: PASS (planner cases). (The DB-driven `runKgCommunityLabels` is exercised in the hybrid test, Task 9.)

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/kg-community-label-job.js test/unit/kg/kg-community-label-job.test.js
git commit -m "feat(kg): nightly community-labeling job with per-day LLM budget (#1126)"
```

---

### Task 6: Register the labeling job in the scheduler

**Files:**
- Modify: `srv/jobs/scheduler.js` (import near line 51; `registerJob` block after the `kg-communities` block ending line 640)
- Test: `test/unit/kg/community-label-scheduled.test.js`

**Interfaces:**
- Consumes: `runKgCommunityLabels` (Task 5); the existing `registerJob`/`JOB_REGISTRY` mechanism.
- Produces: a `kg-community-labels` job at `12 4 * * *`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/community-label-scheduled.test.js
import { describe, it, expect } from 'vitest';
import { _getJobRegistry, registerAllJobs } from '../../../srv/jobs/scheduler.js';

describe('kg-community-labels scheduling (#1126)', () => {
  it('is registered at 04:12 UTC', () => {
    registerAllJobs?.();
    const job = _getJobRegistry().get('kg-community-labels');
    expect(job).toBeTruthy();
    expect(job.schedule).toBe('12 4 * * *');
  });
});
```

> Note: confirm the real exported registry accessor/registration entrypoint names in `srv/jobs/scheduler.js` (grep for `_getJobRegistry` and how `registerJob` is invoked at module load) and adjust the import to match — the KG jobs register at module evaluation, so importing the module may be enough (drop `registerAllJobs?.()` if so).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/community-label-scheduled.test.js`
Expected: FAIL — `job` is `undefined`.

- [ ] **Step 3: Add the import + registration**

In `srv/jobs/scheduler.js`, add after line 51 (`import { runKgCommunities } from './kg-communities-job.js';`):

```javascript
import { runKgCommunityLabels } from './kg-community-label-job.js';
```

Add this `registerJob` block immediately after the `kg-communities` block (after line 640):

```javascript
  // Daily 04:12 UTC — LLM-label each Louvain community (#1126). Runs 15 min
  // after kg-communities (03:57) so labels see the settled nightly membership,
  // and before kg-featured-topics (04:13). Off-minute :12 avoids collisions.
  // Skips communities whose full member set is unchanged; a per-day LLM budget
  // on ChatSettings ramps a first-run backlog. Fail-open: errors -> PipelineLog
  // FAILED, never break request-time reads (findCommunityPeers omits the label).
  // Spec: docs/superpowers/specs/2026-07-12-1126-kg-communities-joule-design.md
  registerJob({
    jobName: 'kg-community-labels',
    schedule: '12 4 * * *',
    ttlMs: 900000,
    description: 'LLM-label KG communities into KgCommunityLabel (#1126)',
    fn: () => runKgCommunityLabels(),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/community-label-scheduled.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/scheduler.js test/unit/kg/community-label-scheduled.test.js
git commit -m "feat(kg): schedule kg-community-labels at 04:12 UTC (#1126)"
```

---

### Task 7: `findCommunityPeers` tool implementation

**Files:**
- Create: `srv/lib/kg/joule-tool-community-peers.js`
- Test: `test/unit/kg/joule-tool-community-peers.test.js`

**Interfaces:**
- Produces:
  - `export const FIND_COMMUNITY_PEERS_TOOL` — LLM function descriptor (name `findCommunityPeers`, params `{ tutorial_slug: string (required), limit?: integer }`).
  - `export async function findCommunityPeersHandler({ db, args }) => Promise<{ label?: string, rationale?: string, peers: Array<{slug,title,url}>, reason?: string }>`.
- Consumes (at dispatch, Task 8): a `db` handle.

**Handler logic:** lowercase slug; resolve `communityFingerprint` from `KgCommunity` where `slug=? and vertexType='tutorial'`; if none → `{ peers: [], reason: 'no-community' }`; else fetch sibling tutorial slugs sharing that fingerprint (exclude self, cap at a hard 50), resolve to published `Tutorials` (slug,title) ordered by title, cap to `limit` (default 5, max 8); read `KgCommunityLabel` (may be null); return peers + optional label. All fail paths return an empty-peers shape (never throw into the chat stream).

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/kg/joule-tool-community-peers.test.js
import { describe, it, expect, vi } from 'vitest';
import { FIND_COMMUNITY_PEERS_TOOL, findCommunityPeersHandler } from '../../../srv/lib/kg/joule-tool-community-peers.js';

// Minimal fake db: dispatch on the first query's target name via a tagged shape.
function fakeDb(routes) {
  return {
    run: vi.fn(async (q) => {
      const target = q?.SELECT?.from?.ref?.[0]?.id || q?.SELECT?.from?.ref?.[0] || q?._t;
      const key = String(target).split('.').pop();
      const handler = routes[key];
      return handler ? handler(q) : [];
    }),
  };
}

describe('FIND_COMMUNITY_PEERS_TOOL descriptor', () => {
  it('requires tutorial_slug', () => {
    expect(FIND_COMMUNITY_PEERS_TOOL.function.name).toBe('findCommunityPeers');
    expect(FIND_COMMUNITY_PEERS_TOOL.function.parameters.required).toContain('tutorial_slug');
  });
});

describe('findCommunityPeersHandler', () => {
  it('returns no-community when the slug is in no community', async () => {
    const db = { run: vi.fn().mockResolvedValue([]) };
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'Orphan-Slug' } });
    expect(out).toEqual({ peers: [], reason: 'no-community' });
    // slug was lowercased before the query
    const firstCall = db.run.mock.calls[0];
    expect(JSON.stringify(firstCall)).toContain('orphan-slug');
  });

  it('excludes self and caps to limit, attaching the label', async () => {
    let phase = 0;
    const db = {
      run: vi.fn().mockImplementation(async () => {
        phase++;
        if (phase === 1) return [{ communityFingerprint: 'fp1' }];                // resolve
        if (phase === 2) return [{ slug: 'a' }, { slug: 'self' }, { slug: 'b' }]; // siblings
        if (phase === 3) return [{ slug: 'a', title: 'Alpha' }, { slug: 'b', title: 'Bravo' }]; // tutorials
        if (phase === 4) return [{ label: 'The Cluster', rationale: 'why' }];     // label
        return [];
      }),
    };
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'self', limit: 5 } });
    expect(out.label).toBe('The Cluster');
    expect(out.peers.map((p) => p.slug).sort()).toEqual(['a', 'b']);
    expect(out.peers[0].url).toContain('/tutorials/');
  });

  it('omits label when none stored, still returns peers', async () => {
    let phase = 0;
    const db = {
      run: vi.fn().mockImplementation(async () => {
        phase++;
        if (phase === 1) return [{ communityFingerprint: 'fp1' }];
        if (phase === 2) return [{ slug: 'a' }];
        if (phase === 3) return [{ slug: 'a', title: 'Alpha' }];
        return []; // no label row
      }),
    };
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'x' } });
    expect(out.label).toBeUndefined();
    expect(out.peers).toHaveLength(1);
  });

  it('fails open to empty peers on db error', async () => {
    const db = { run: vi.fn().mockRejectedValue(new Error('boom')) };
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: 'x' } });
    expect(out.peers).toEqual([]);
    expect(out.reason).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/kg/joule-tool-community-peers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (uses cds.ql so the same code runs on SQLite unit tests and HANA; all columns scalar)

```javascript
// srv/lib/kg/joule-tool-community-peers.js
// Joule chat tool: findCommunityPeers (#1126).
// Given a tutorial slug, returns sibling tutorials from the same Louvain
// community (KgCommunity, keyed by stable communityFingerprint) plus the
// LLM-generated cluster label (KgCommunityLabel). Fail-open: every error path
// returns an empty-peers shape so the chat stream never 500s.

import cds from '@sap/cds';

const LOG = cds.log('kg-community-peers');
const NS = 'com.sap.developers.ims';
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const HARD_SIBLING_CAP = 50;   // communities are small; defensive bound on the .in([]) set

export const FIND_COMMUNITY_PEERS_TOOL = {
  type: 'function',
  function: {
    name: 'findCommunityPeers',
    description: [
      'Given a tutorial the learner is on or asking about, return other tutorials',
      'from the same tightly-connected topic cluster (community) — a coherent themed',
      'set that tends to be learned together, with a short cluster label.',
      'Use for "what should I learn next" / "what else is in this area" questions',
      'when the learner is anchored to a specific tutorial.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tutorial_slug: { type: 'string', description: 'Slug of the anchor tutorial. Lowercase alphanumeric + hyphens.' },
        limit: { type: 'integer', description: 'Max sibling tutorials to return. 1-8, default 5.' },
      },
      required: ['tutorial_slug'],
    },
  },
};

/**
 * @param {object} opts
 * @param {object} opts.db   - CDS db handle
 * @param {object} opts.args - { tutorial_slug, limit? } from the LLM tool call
 * @returns {Promise<{label?:string, rationale?:string, peers:Array<{slug,title,url}>, reason?:string}>}
 */
export async function findCommunityPeersHandler({ db, args }) {
  const slug = typeof args?.tutorial_slug === 'string' ? args.tutorial_slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { peers: [], reason: 'bad-slug' };

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args?.limit) || DEFAULT_LIMIT));
  const { KgCommunity, KgCommunityLabel, Tutorials } = cds.entities(NS);

  try {
    // 1. Resolve the anchor's community fingerprint.
    const anchor = await db.run(
      SELECT.one.from(KgCommunity).columns('communityFingerprint')
        .where({ slug, vertexType: 'tutorial' })
    );
    const fp = anchor?.communityFingerprint;
    if (!fp) return { peers: [], reason: 'no-community' };

    // 2. Sibling tutorial slugs sharing the fingerprint (exclude self).
    const siblingRows = await db.run(
      SELECT.from(KgCommunity).columns('slug')
        .where({ communityFingerprint: fp, vertexType: 'tutorial' })
        .limit(HARD_SIBLING_CAP)
    );
    const siblingSlugs = [...new Set(siblingRows.map((r) => r.slug?.toLowerCase()).filter(Boolean))]
      .filter((s) => s !== slug);
    if (siblingSlugs.length === 0) return { peers: [], reason: 'singleton' };

    // 3. Resolve to published tutorials, ordered by title, capped to limit.
    const tutRows = await db.run(
      SELECT.from(Tutorials).columns('slug', 'title')
        .where({ slug: { in: siblingSlugs }, published: true })
        .orderBy('title asc')
    );
    const peers = tutRows.slice(0, limit).map((t) => ({
      slug: t.slug,
      title: t.title,
      url: `https://developers.sap.com/tutorials/${t.slug}.html`,
    }));
    if (peers.length === 0) return { peers: [], reason: 'no-published-peers' };

    // 4. Attach the cluster label if one exists.
    const labelRow = await db.run(
      SELECT.one.from(KgCommunityLabel).columns('label', 'rationale')
        .where({ communityFingerprint: fp })
    );

    const out = { peers };
    if (labelRow?.label) { out.label = labelRow.label; out.rationale = labelRow.rationale || undefined; }
    return out;
  } catch (err) {
    LOG.warn('findCommunityPeers dispatch failed:', err.message);
    return { peers: [], reason: 'error' };
  }
}

export default { FIND_COMMUNITY_PEERS_TOOL, findCommunityPeersHandler };
```

> Note: the fake-db test asserts on lowercasing and result shaping. If cds.ql query introspection in the fake proves brittle, swap the fake for a real in-memory `cds.test` bootstrap seeding `KgCommunity`/`Tutorials`/`KgCommunityLabel` — same assertions. Prefer whichever the neighboring `test/unit/kg/*` tests already use.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/kg/joule-tool-community-peers.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg/joule-tool-community-peers.js test/unit/kg/joule-tool-community-peers.test.js
git commit -m "feat(kg): findCommunityPeers tool handler + descriptor (#1126)"
```

---

### Task 8: Wire the tool into the orchestrator (registry + prompt + dispatch + SSE)

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (import top; registry ~line 313; prompt ~line 337; dispatch ~line 679; SSE ~line 813; export ~line 853)
- Test: `test/chat-orchestrator-community-peers.test.js`

**Interfaces:**
- Consumes: `FIND_COMMUNITY_PEERS_TOOL`, `findCommunityPeersHandler` (Task 7); `settings.communityPeersEnabled` (Task 2).
- Produces: `findCommunityPeers` registered when the flag is on; dispatch returns the handler's object; SSE `community-peers-cards` frame emitted when `result.peers.length > 0`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/chat-orchestrator-community-peers.test.js
import { describe, it, expect } from 'vitest';
import { buildToolRegistry, buildSystemPromptLines } from '../srv/lib/chat-orchestrator.js';

describe('findCommunityPeers registry gating (#1126)', () => {
  it('is absent when communityPeersEnabled is false', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: false } }).map((t) => t.function.name);
    expect(names).not.toContain('findCommunityPeers');
  });
  it('is present when communityPeersEnabled is true', () => {
    const names = buildToolRegistry({ settings: { communityPeersEnabled: true } }).map((t) => t.function.name);
    expect(names).toContain('findCommunityPeers');
  });
  it('adds a system-prompt line when enabled', () => {
    const lines = buildSystemPromptLines({ settings: { communityPeersEnabled: true } });
    expect(lines.join('\n')).toMatch(/findCommunityPeers/);
  });
  it('emits no prompt line when disabled', () => {
    const lines = buildSystemPromptLines({ settings: { communityPeersEnabled: false } });
    expect(lines.join('\n')).not.toMatch(/findCommunityPeers/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat-orchestrator-community-peers.test.js`
Expected: FAIL — `findCommunityPeers` not in registry.

- [ ] **Step 3: Add the import**

At the top of `srv/lib/chat-orchestrator.js`, after line 7 (the `joule-tool-find-path.js` import):

```javascript
import { FIND_COMMUNITY_PEERS_TOOL, findCommunityPeersHandler } from './kg/joule-tool-community-peers.js';
```

- [ ] **Step 4: Register in `buildToolRegistry`**

In `buildToolRegistry`, after the `kgRelatedContentEnabled` block (after line 313, before `return tools;`):

```javascript
  if (settings?.communityPeersEnabled) {
    tools.push(FIND_COMMUNITY_PEERS_TOOL);
  }
```

- [ ] **Step 5: Add the system-prompt line**

In `buildSystemPromptLines`, after the `kgRelatedContentEnabled` block (after line 337, before `return lines;`):

```javascript
  if (settings?.communityPeersEnabled) {
    lines.push(
      "When the learner asks what to learn next or what else is in the same area AND they are anchored to a specific tutorial, call `findCommunityPeers` with that tutorial's slug. Present the returned peers as a coherent set, and if a cluster label is provided, introduce them with it (e.g. \"These are part of the SAP RAP & Fiori Elements area\")."
    );
  }
```

- [ ] **Step 6: Add dispatch**

In `dispatchTool`, before the final `return { error: 'unknown_tool' };` (line 681):

```javascript
  if (name === 'findCommunityPeers') {
    try {
      const db = await cds.connect.to('db');
      return await findCommunityPeersHandler({ db, args });
    } catch (err) {
      LOG.warn('findCommunityPeers dispatch failed:', err.message);
      return { peers: [], reason: 'dispatch_failed' };
    }
  }
```

- [ ] **Step 7: Add the SSE frame**

In `streamChat`'s tool-result switch, after the `findRelatedContent` branch (after line 814):

```javascript
        } else if (tc.name === 'findCommunityPeers' && result && Array.isArray(result.peers) && result.peers.length > 0) {
          sse(res, { type: 'community-peers-cards', label: result.label, items: result.peers });
        }
```

- [ ] **Step 8: Extend the export list**

On line 853, add `FIND_COMMUNITY_PEERS_TOOL` to the exported names:

```javascript
export { SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GET_RELEVANT_STEPS_TOOL, GET_USER_PROGRESS_TOOL, CHECK_CODE_TOOL, GET_DEVTOBERFEST_INFO_TOOL, GET_BRANCH_RECOMMENDATION_TOOL, FIND_LEARNING_PATH_TOOL, EXPAND_SEARCH_CONCEPTS_TOOL, FIND_RELATED_CONTENT_TOOL, FIND_COMMUNITY_PEERS_TOOL, toolsForContext };
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/chat-orchestrator-community-peers.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator-community-peers.test.js
git commit -m "feat(kg): wire findCommunityPeers into chat orchestrator behind communityPeersEnabled (#1126)"
```

---

### Task 9: Render `community-peers-cards` in joule.js + hybrid coverage

**Files:**
- Modify: `hugo/static/js/joule.js` (SSE switch ~line 724; add a `renderCommunityPeersCards` helper near `renderExternalContentCards`)
- Create: `test/hybrid/kg-community-peers.test.js`

**Interfaces:**
- Consumes: the `community-peers-cards` SSE frame (Task 8); `KgCommunity`/`KgCommunityLabel`/`Tutorials` on real HANA.

- [ ] **Step 1: Add the SSE frame handler**

In `hugo/static/js/joule.js`, in the `payload.type` chain, after the `external-content-cards` branch (line 724):

```javascript
          } else if (payload.type === 'community-peers-cards') {
            needsTurnBreak = true;
            renderCommunityPeersCards(payload.items || [], payload.label);
```

- [ ] **Step 2: Add the render helper**

Add `renderCommunityPeersCards` next to `renderExternalContentCards` (find it via `grep -n renderExternalContentCards hugo/static/js/joule.js`). Model it on that helper — internal tutorial links, cluster label as the group heading:

```javascript
  function renderCommunityPeersCards(items, label) {
    if (!Array.isArray(items) || !items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'joule-community-peers';
    if (label) {
      const h = document.createElement('div');
      h.className = 'joule-community-peers__label';
      h.textContent = label;
      wrap.appendChild(h);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.className = 'joule-tutorial-card';
      a.href = it.url;
      a.textContent = it.title || it.slug;
      wrap.appendChild(a);
    }
    transcript.insertBefore(wrap, assistantBubble);
  }
```

> Note: match the exact DOM/class conventions of `renderExternalContentCards` in the live file (element factory helper, card class names, insertion target variable). The block above is the shape; align names to what that helper actually uses.

- [ ] **Step 3: Write the hybrid test**

```javascript
// test/hybrid/kg-community-peers.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { findCommunityPeersHandler } from '../../srv/lib/kg/joule-tool-community-peers.js';

describe('findCommunityPeers on real HANA (#1126)', () => {
  let db;
  const FP = 'testfp1126000000000000000000000000000000000000000000000000000000';
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { KgCommunity, KgCommunityLabel } = cds.entities('com.sap.developers.ims');
    // Seed two tutorial members of one community + a label. Uses real published
    // tutorial slugs so the Tutorials join resolves; pick two that exist.
    const tuts = await db.run(SELECT.from('com.sap.developers.ims.Tutorials').columns('slug').where({ published: true }).limit(2));
    const [a, b] = tuts.map((t) => t.slug.toLowerCase());
    await db.run(DELETE.from(KgCommunity).where({ communityFingerprint: FP }));
    await db.run(INSERT.into(KgCommunity).entries([
      { communityId: 999001, vertexKey: `tutorial:${a}`, vertexType: 'tutorial', slug: a, detectedAt: new Date().toISOString(), communityFingerprint: FP },
      { communityId: 999001, vertexKey: `tutorial:${b}`, vertexType: 'tutorial', slug: b, detectedAt: new Date().toISOString(), communityFingerprint: FP },
    ]));
    await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: FP }));
    await db.run(INSERT.into(KgCommunityLabel).entries({ communityFingerprint: FP, label: 'Test Cluster', rationale: 'seeded', memberSlugsHash: 'x', labeledAt: new Date().toISOString(), model: 'test' }));
    globalThis.__peerSeed = { a, b };
  });

  it('returns the sibling and the label', async () => {
    const { a, b } = globalThis.__peerSeed;
    const out = await findCommunityPeersHandler({ db, args: { tutorial_slug: a } });
    expect(out.label).toBe('Test Cluster');
    expect(out.peers.map((p) => p.slug)).toContain(b);
    expect(out.peers.map((p) => p.slug)).not.toContain(a);
  });
});
```

- [ ] **Step 4: Run the hybrid test** (requires `cf login` + `cds bind`)

Run: `npx vitest run --project hybrid test/hybrid/kg-community-peers.test.js`
Expected: PASS. If the environment lacks a HANA binding, note it and defer to CI — do NOT weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add hugo/static/js/joule.js test/hybrid/kg-community-peers.test.js
git commit -m "feat(kg): render community-peers-cards in Joule + hybrid coverage (#1126)"
```

---

### Task 10: srv-qa cp audit + full test sweep + PROD-rollout notes

**Files:**
- Modify: `.deploy/mta.yaml` (`srv-qa` module `cp` list) — only if the audit finds a gap
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (add a `KG_ community peers` gotcha row) and `CLAUDE.md` Top Gotchas (one bullet), mirroring the #917/#1125 entries
- Modify: `deploy/dev.mtaext` / relevant mtaext — confirm `KNOWLEDGE_GRAPH_ENABLED` is set so the Louvain + label jobs run

- [ ] **Step 1: Audit the srv-qa cp list**

Walk transitive `./` imports from `srv/lib/content-store.js`. The new files (`srv/lib/kg/joule-tool-community-peers.js`, `srv/lib/kg/community-label-llm.js`, `srv/lib/kg/community-member-hash.js`, `srv/jobs/kg-community-label-job.js`) are reached via chat-orchestrator/scheduler, NOT content-store — so they should already be covered by the existing `srv/**` copy globs. Confirm:

Run: `grep -n "srv/lib/kg\|srv/jobs\|srv/lib/chat-orchestrator" .deploy/mta.yaml`
Expected: the `srv-qa` `cp` list already globs `srv/**` (or lists `srv/lib/kg` + `srv/jobs`). If a specific-file list is used and any new file is missing, add it. If it globs `srv/`, no change needed.

- [ ] **Step 2: Confirm PROD Louvain enablement**

Run: `grep -rn "KNOWLEDGE_GRAPH_ENABLED" deploy/`
Expected: the target mtaext sets `KNOWLEDGE_GRAPH_ENABLED: true` on `tutorials-srv`. If absent for PROD, add it (this is the switch that makes both `kg-communities` and the new `kg-community-labels` jobs run). Document that `communityPeersEnabled` stays OFF until one nightly cycle verifies `KgCommunity` + `KgCommunityLabel` populate in PROD.

- [ ] **Step 3: Add the gotcha docs**

Add one bullet to `CLAUDE.md` Top Gotchas and a row to `docs/developers/reference/tutorials-ims-gotchas.md` summarizing: `communityPeersEnabled` (default off) gates the `findCommunityPeers` Joule tool; nightly `kg-community-labels` job (04:12 UTC) LLM-labels communities into `KgCommunityLabel` keyed on `communityFingerprint`, skip-keyed on `memberSlugsHash`, capped by `communityLabelLlmBudgetPerDay` (default 50); fail-open; toggle via `/admin-ui/#kg-settings` or `cf set-env tutorials-srv` + restart.

- [ ] **Step 4: Full unit sweep**

Run: `npm test`
Expected: all unit tests pass (in-memory SQLite). Confirm no regression in existing `chat-orchestrator`/`scheduler`/`ChatSettings` tests.

- [ ] **Step 5: Verify build once more**

Run: `npx cds build --production && npx cds deploy --to sqlite::memory: 2>&1 | tail -3`
Expected: clean build + in-memory deploy (catches any residual schema drift).

- [ ] **Step 6: Commit**

```bash
git add .deploy/mta.yaml deploy/ CLAUDE.md docs/developers/reference/tutorials-ims-gotchas.md db/last-dev/csn.json
git commit -m "chore(kg): srv-qa cp audit, PROD Louvain enablement, gotcha docs for #1126"
```

---

## Post-implementation (out of TDD loop)

1. Open a **draft PR** (`gh pr create --draft`) targeting `main`, referencing #1126 and noting it is PR 1 of the epic. Body: link the spec, list the dark→live rollout order, and the explicit "flip `communityPeersEnabled` after PROD data verified" step.
2. Do NOT flip `communityPeersEnabled` in code — it ships OFF; enablement is an operator action post-deploy.
3. Later PRs (out of scope): homepage topic-cluster band, search-rank community-overlap term, curator-assist nudges, cluster-level Q&A.

## Self-Review

- **Spec coverage:** PROD rollout (Task 10 Step 2) ✓; labeling job + sidecar (Tasks 1,3,4,5,6) ✓; fingerprint-keyed identity + memberSlugsHash skip-key (Tasks 1,4,5) ✓; Joule tool + flag + prompt + dispatch + SSE + render (Tasks 2,7,8,9) ✓; fail-open on every path (Tasks 5,7,8) ✓; testing matrix — unit + registry + hybrid (Tasks 1,3,4,5,6,7,8,9) ✓; no-CSV-seed, hdbmigrationtable lockstep, cds build --production (Global Constraints + Tasks 1,2) ✓.
- **Placeholder scan:** every code step carries full code; two `> Note:` callouts flag *live-file alignment* (scheduler registry accessor name; joule.js render-helper class names) — these are verification hooks, not missing content, because the exact private names must be confirmed against the file at edit time.
- **Type consistency:** `communityFingerprint` (String(64)) used identically across Tasks 1,5,7,9; `findCommunityPeersHandler({db,args})` and `{ label?, rationale?, peers, reason? }` return shape consistent across Tasks 7,8,9; `runKgCommunityLabels` consistent across Tasks 5,6; `FIND_COMMUNITY_PEERS_TOOL` name `findCommunityPeers` consistent across Tasks 7,8.
