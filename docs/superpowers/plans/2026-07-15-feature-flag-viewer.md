# Feature Flag Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Admin UI tile that lists every feature flag with its live resolved state (effective value, which layer won, and raw db/env/default values) plus how-to-change guidance.

**Architecture:** A hand-authored registry (`srv/lib/feature-flags/registry.js`) is the source of truth. A resolver (`srv/lib/feature-flags/resolve.js`) computes each flag's effective state by delegating to the existing settings resolvers (KG/UiEvents) or reading the DB row / `process.env` directly (chat booleans / pure env flags). A read-only `AdminService.FeatureFlags` entity exposes the resolved rows to a Fiori Elements ListReport + ObjectPage. A drift test greps `srv/**` and the CDS model to fail the build when a new flag is unregistered.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), Fiori Elements (`sap.fe.templates`), Vitest, OData V4.

## Global Constraints

- **Node ESM in `srv/`** — `srv/lib/**` uses `import`/`export` (see `kg-settings.js`). Match it.
- **CommonJS in `test/**`** unless the file already uses ESM — check the neighbor; this repo's unit tests run under Vitest which supports both. Follow the pattern of an existing `test/unit/*.test.js`.
- **Never SELECT a HANA BLOB alongside metadata** — N/A here (no BLOBs), but do not add columns that trigger it.
- **CSV seeds for settings entities MUST stay empty** — do not add rows to `db/data/*-ChatSettings.csv` etc. This plan adds no CSV changes.
- **No new DB table** — `FeatureFlags` is an unbacked read-only entity resolved in an `on('READ')` handler.
- **Admin shell manifest is generated** — never hand-edit `app/admin-shell/webapp/manifest.json`. Editing the two hand-curated lists (`navigation.json`, `Shell.controller.js` NAV maps) plus creating the app folder is the correct wiring.
- **`@requires: 'Admin'`** — inherited from the `AdminService` service-level annotation; the entity needs no extra auth annotation but must live inside that service.
- **Fail-quiet** — per-flag resolution errors must never 500; yield an error sentinel row instead (mirrors `admin-service.js` `after('READ')` patterns).
- **Address the user as Tom.**

---

## File Structure

- `srv/lib/feature-flags/registry.js` (create) — descriptor array + enums, no I/O.
- `srv/lib/feature-flags/resolve.js` (create) — `resolveFeatureFlags()`; imports registry + the three settings resolvers.
- `srv/admin-service.cds` (modify) — add `FeatureFlags` read-only entity + its element types.
- `srv/admin-service.js` (modify) — add `on('READ', 'FeatureFlags')` handler.
- `app/admin-annotations.cds` (modify) — `@UI.LineItem` / `HeaderInfo` / `Facets` for `FeatureFlags`.
- `app/admin/featureFlags/webapp/{Component.js,manifest.json,i18n/i18n.properties}` (create) — FE app.
- `app/admin-shell/webapp/model/navigation.json` (modify) — nav entry.
- `app/admin-shell/webapp/controller/Shell.controller.js` (modify) — `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE`.
- `test/unit/feature-flags-registry.test.js` (create) — shape + drift + resolution tests.

---

## Task 1: Registry module + shape test

**Files:**
- Create: `srv/lib/feature-flags/registry.js`
- Test: `test/unit/feature-flags-registry.test.js`

**Interfaces:**
- Produces: `export const FEATURE_FLAGS` — array of descriptor objects. `export const KINDS = ['env','db-setting','constant']`, `export const ENV_RULES = ['true-enables','false-disables','numeric']`, `export const STATUSES = ['ga','dev-only','beta','parked']`.
- Descriptor shape (see below). Consumed by Task 2 (`resolve.js`) and Task 6 (drift test).

- [ ] **Step 1: Write the failing shape test**

Create `test/unit/feature-flags-registry.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { FEATURE_FLAGS, KINDS, ENV_RULES, STATUSES } from '../../srv/lib/feature-flags/registry.js';

describe('feature-flag registry shape', () => {
  it('has at least the known flags', () => {
    expect(FEATURE_FLAGS.length).toBeGreaterThanOrEqual(15);
  });

  it('every descriptor has required fields with valid enums', () => {
    for (const f of FEATURE_FLAGS) {
      expect(typeof f.key, `key on ${JSON.stringify(f)}`).toBe('string');
      expect(f.key.length).toBeGreaterThan(0);
      expect(typeof f.label).toBe('string');
      expect(typeof f.category).toBe('string');
      expect(KINDS).toContain(f.kind);
      expect(STATUSES).toContain(f.status);
      expect(typeof f.description).toBe('string');
      if (f.kind === 'env') {
        expect(typeof f.envVar).toBe('string');
        expect(ENV_RULES).toContain(f.envRule);
      }
      if (f.kind === 'db-setting') {
        expect(typeof f.entity).toBe('string');
        expect(typeof f.column).toBe('string');
        expect(['kg', 'uiEvents', 'chat']).toContain(f.resolver);
      }
    }
  });

  it('keys are unique', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: FAIL — `Cannot find module '.../srv/lib/feature-flags/registry.js'`.

- [ ] **Step 3: Create the registry**

Create `srv/lib/feature-flags/registry.js`. Include every flag found in the audit. `resolver` on db-setting entries selects which resolver Task 2 calls: `'kg'` → `resolveKnowledgeGraphSettings`, `'uiEvents'` → `resolveUiEventsSettings`, `'chat'` → direct DB read of `ChatSettings` (no env layer).

```js
// srv/lib/feature-flags/registry.js
// Hand-authored source of truth for the Feature Flag Viewer (Admin UI).
// The drift test in test/unit/feature-flags-registry.test.js fails the build
// if a new env flag or settings boolean is added without a matching entry.
//
// kind:
//   'env'        — read from process.env; effective value via envRule.
//   'db-setting' — a boolean/number column on a settings entity.
//                  `resolver` picks how the effective value is resolved:
//                    'kg'/'uiEvents' → the env-layered resolveXSettings()
//                    'chat'          → direct ChatSettings row (no env layer)
//   'constant'   — a hardcoded, non-runtime-configurable value (shown, no howToChange).
// envRule: 'true-enables' | 'false-disables' | 'numeric'.
// status:  'ga' | 'dev-only' | 'beta' | 'parked'.

export const KINDS = ['env', 'db-setting', 'constant'];
export const ENV_RULES = ['true-enables', 'false-disables', 'numeric'];
export const STATUSES = ['ga', 'dev-only', 'beta', 'parked'];

const cfEnv = (name, value) => ({
  method: 'cf-env',
  command: `cf set-env tutorials-srv ${name} ${value} && cf restart tutorials-srv`,
});
const adminTile = (tile, hash, note) => ({ method: 'admin-tile', tile, hash, note });

export const FEATURE_FLAGS = [
  // ---- Knowledge Graph env flags (env-layered via resolveKnowledgeGraphSettings where applicable) ----
  {
    key: 'KNOWLEDGE_GRAPH_ENABLED', label: 'Knowledge Graph master switch',
    category: 'Knowledge Graph', kind: 'db-setting', entity: 'KnowledgeGraphSettings',
    column: 'enabled', resolver: 'kg', valueType: 'boolean', default: false,
    issue: '', status: 'ga',
    description: 'Master switch for the /graph/* service surface. Off → 503.',
    howToChange: adminTile('knowledgeGraph', '#knowledgeGraph', 'Or env KNOWLEDGE_GRAPH_ENABLED.'),
  },
  {
    key: 'KG_ONDEMAND_ENABLED', label: 'KG on-demand extraction',
    category: 'Knowledge Graph', kind: 'db-setting', entity: 'KnowledgeGraphSettings',
    column: 'onDemandExtractionEnabled', resolver: 'kg', valueType: 'boolean',
    default: false, issue: '#948', status: 'ga',
    description: 'On-demand concept extraction from zero-seed search queries.',
    howToChange: adminTile('knowledgeGraph', '#knowledgeGraph', 'Or env KG_ONDEMAND_ENABLED.'),
  },
  {
    key: 'KG_PAGERANK_ENABLED', label: 'KG PageRank blend', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_PAGERANK_ENABLED', envRule: 'true-enables',
    valueType: 'boolean', default: false, issue: '#916', status: 'ga',
    description: 'Blends per-tutorial PageRank into KG neighborhood ranking.',
    howToChange: cfEnv('KG_PAGERANK_ENABLED', 'true'),
  },
  {
    key: 'KG_PATH_V2_ENABLED', label: 'KG path-finding v2', category: 'Knowledge Graph',
    kind: 'env', envVar: 'KG_PATH_V2_ENABLED', envRule: 'true-enables',
    valueType: 'boolean', default: false, issue: '#913', status: 'beta',
    description: 'Property-graph v2 pathBetween with fail-open v1 SPARQL fallback.',
    howToChange: cfEnv('KG_PATH_V2_ENABLED', 'true'),
  },
  {
    key: 'KG_COMMUNITY_WEIGHT', label: 'KG community search weight',
    category: 'Knowledge Graph', kind: 'env', envVar: 'KG_COMMUNITY_WEIGHT',
    envRule: 'numeric', valueType: 'number', default: 0, issue: '#1171', status: 'dev-only',
    description: 'Additive Louvain-community rank term in search (>0 enables). Requires searchKgRerankEnabled=true.',
    howToChange: cfEnv('KG_COMMUNITY_WEIGHT', '1.5'),
  },
  {
    key: 'KG_WEIGHT', label: 'KG concept-overlap search weight',
    category: 'Knowledge Graph', kind: 'constant', valueType: 'number', default: 2.0,
    issue: '#945', status: 'ga',
    description: 'Hardcoded concept-overlap rank multiplier. Not runtime-configurable.',
  },
  // ---- UI events ----
  {
    key: 'UI_EVENTS_ENABLED', label: 'UI event telemetry', category: 'Telemetry',
    kind: 'db-setting', entity: 'UiEventsSettings', column: 'enabled', resolver: 'uiEvents',
    valueType: 'boolean', default: false, issue: '#204', status: 'ga',
    description: 'UI event tracking. Off → /api/ui-event 503, tracker self-disables.',
    howToChange: adminTile('uiEvents', '#uiEvents', 'Or env UI_EVENTS_ENABLED.'),
  },
  // ---- Chat / AI booleans (direct ChatSettings row; NO env layer) ----
  {
    key: 'ChatSettings.enabled', label: 'Joule chat master switch', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'enabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '', status: 'ga',
    description: 'Master switch for the Joule chat assistant.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.ragEnabled', label: 'RAG / vector grounding', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'ragEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '', status: 'ga',
    description: 'Retrieval-augmented grounding over tutorial embeddings.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.codeCheckEnabled', label: 'AI code-check', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'codeCheckEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#171', status: 'ga',
    description: 'AI code-check tool. Off → /api/codecheck 503.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.validateAnswerEnabled', label: 'AI answer grader', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'validateAnswerEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#209', status: 'ga',
    description: 'AI free-text answer grader. Off → /api/validate-answer 503.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.branchingEnabled', label: 'Branching learning paths', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'branchingEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#172', status: 'ga',
    description: 'Branching paths master flag. Off → /api/branches/decide 404.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.kgPathBetweenEnabled', label: 'KG learning-path tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgPathBetweenEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#445', status: 'ga',
    description: 'findLearningPath Joule tool registration.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.communityPeersEnabled', label: 'KG community-peers tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'communityPeersEnabled', resolver: 'chat',
    valueType: 'boolean', default: false, issue: '#1126', status: 'dev-only',
    description: 'findCommunityPeers Joule tool. Ships dark until PROD Louvain data verified.',
    howToChange: adminTile('joule', '#joule',
      'Not yet on the Joule Settings form — PATCH /admin/ChatSettings(<ID>) directly until added.'),
  },
  {
    key: 'ChatSettings.kgSearchExpansionEnabled', label: 'KG search expansion', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgSearchExpansionEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#943', status: 'ga',
    description: 'expandSearchConcepts Joule tool. Default ON (cheap).',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.searchKgRerankEnabled', label: 'KG-boosted search ranking', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'searchKgRerankEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#945', status: 'ga',
    description: 'Server-side KG rerank of search results. Default ON. Gates KG_COMMUNITY_WEIGHT.',
    howToChange: adminTile('joule', '#joule'),
  },
  {
    key: 'ChatSettings.kgRelatedContentEnabled', label: 'KG related-content tool', category: 'Chat / AI',
    kind: 'db-setting', entity: 'ChatSettings', column: 'kgRelatedContentEnabled', resolver: 'chat',
    valueType: 'boolean', default: true, issue: '#1125', status: 'ga',
    description: 'findRelatedContent Joule tool. Default ON (cache-reused).',
    howToChange: adminTile('joule', '#joule'),
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feature-flags/registry.js test/unit/feature-flags-registry.test.js
git commit -m "feat(#feature-flags): registry of feature-flag descriptors + shape test"
```

---

## Task 2: Resolver (`resolveFeatureFlags`)

**Files:**
- Create: `srv/lib/feature-flags/resolve.js`
- Test: `test/unit/feature-flags-registry.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `FEATURE_FLAGS` from Task 1; `resolveKnowledgeGraphSettings` (from `srv/lib/runtime-config/kg-settings.js`, returns `{ enabled, onDemandExtractionEnabled, ... }`), `resolveUiEventsSettings` (from `srv/lib/runtime-config/ui-events-settings.js`, returns `{ enabled }`).
- Produces: `export async function resolveFeatureFlags()` → `Promise<Array<Row>>` where `Row` = `{ key, label, category, kind, valueType, issue, status, description, effectiveValue: string, enabled: boolean, winningLayer: 'db'|'env'|'default'|'constant'|'unknown', rawDbValue: string|null, rawEnvValue: string|null, defaultValue: string, howToChangeText: string }`.

- [ ] **Step 1: Write failing resolution tests**

Append to `test/unit/feature-flags-registry.test.js`:

```js
import { vi } from 'vitest';

describe('resolveFeatureFlags precedence + polarity', () => {
  it('env true-enables flag reads on when env=true, default when unset', async () => {
    vi.resetModules();
    // KG resolvers hit cds; stub them so the module import is side-effect free.
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => ({ enabled: false, onDemandExtractionEnabled: false }),
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');

    process.env.KG_PAGERANK_ENABLED = 'true';
    const rows = await resolveFeatureFlags();
    const pr = rows.find((r) => r.key === 'KG_PAGERANK_ENABLED');
    expect(pr.enabled).toBe(true);
    expect(pr.winningLayer).toBe('env');
    expect(pr.rawEnvValue).toBe('true');

    delete process.env.KG_PAGERANK_ENABLED;
    const rows2 = await resolveFeatureFlags();
    const pr2 = rows2.find((r) => r.key === 'KG_PAGERANK_ENABLED');
    expect(pr2.enabled).toBe(false);
    expect(pr2.winningLayer).toBe('default');
  });

  it('numeric env flag enables when > 0', async () => {
    vi.resetModules();
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => ({ enabled: false, onDemandExtractionEnabled: false }),
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');

    process.env.KG_COMMUNITY_WEIGHT = '1.5';
    const rows = await resolveFeatureFlags();
    const cw = rows.find((r) => r.key === 'KG_COMMUNITY_WEIGHT');
    expect(cw.enabled).toBe(true);
    expect(cw.effectiveValue).toBe('1.5');
    delete process.env.KG_COMMUNITY_WEIGHT;
  });

  it('constant flag reports constant layer and no howToChange', async () => {
    vi.resetModules();
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => ({ enabled: false, onDemandExtractionEnabled: false }),
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');
    const rows = await resolveFeatureFlags();
    const kw = rows.find((r) => r.key === 'KG_WEIGHT');
    expect(kw.winningLayer).toBe('constant');
    expect(kw.howToChangeText).toContain('Not runtime-configurable');
  });

  it('a throwing resolver yields an error sentinel, not a rejection', async () => {
    vi.resetModules();
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => { throw new Error('boom'); },
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');
    const rows = await resolveFeatureFlags();
    const kg = rows.find((r) => r.key === 'KNOWLEDGE_GRAPH_ENABLED');
    expect(kg.winningLayer).toBe('unknown');
    expect(kg.effectiveValue).toBe('error');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: FAIL — `Cannot find module '.../srv/lib/feature-flags/resolve.js'`.

- [ ] **Step 3: Implement `resolve.js`**

Create `srv/lib/feature-flags/resolve.js`. Chat booleans are read from the `ChatSettings` row directly (no env layer) — one fetch, reused across all chat flags. KG/UiEvents flags call their env-layered resolvers once each and also fetch the raw row to compute `winningLayer`/`rawDbValue`.

```js
// srv/lib/feature-flags/resolve.js
// Resolves each registry descriptor into a display row for the Feature Flag
// Viewer. Delegates effective-value logic to the existing settings resolvers
// so precedence rules live in exactly one place per settings group.
import cds from '@sap/cds';
import { FEATURE_FLAGS } from './registry.js';
import { resolveKnowledgeGraphSettings } from '../runtime-config/kg-settings.js';
import { resolveUiEventsSettings } from '../runtime-config/ui-events-settings.js';

const LOG = cds.log('feature-flags-resolver');
const NS = 'com.sap.developers.ims';

const asStr = (v) => (v === undefined || v === null ? null : String(v));

/** Read one settings singleton row (lowercase CAP keys). Null on any failure. */
async function readRow(entityName) {
  try {
    const ent = cds.entities(NS)[entityName];
    if (!ent) return null;
    return (await SELECT.one.from(ent)) ?? null;
  } catch (err) {
    LOG.warn(`${entityName} raw read failed`, err.message);
    return null;
  }
}

function envRaw(name) {
  const v = process.env[name];
  return v === undefined ? null : v;
}

/** Effective boolean for an env flag given its polarity rule. */
function envBool(raw, rule) {
  if (rule === 'true-enables') return raw === 'true';
  if (rule === 'false-disables') return raw !== 'false'; // unset or anything but 'false' → on
  return false;
}

export async function resolveFeatureFlags() {
  // Resolve the two env-layered settings groups once, and fetch the raw rows
  // once, tolerating individual failures.
  const [kgResolved, uiResolved, kgRow, uiRow, chatRow] = await Promise.all([
    resolveKnowledgeGraphSettings().catch((e) => { LOG.warn('kg resolve failed', e.message); return null; }),
    resolveUiEventsSettings().catch((e) => { LOG.warn('uiEvents resolve failed', e.message); return null; }),
    readRow('KnowledgeGraphSettings'),
    readRow('UiEventsSettings'),
    readRow('ChatSettings'),
  ]);

  const resolvedByResolver = { kg: kgResolved, uiEvents: uiResolved };
  const rowByEntity = { KnowledgeGraphSettings: kgRow, UiEventsSettings: uiRow, ChatSettings: chatRow };

  return FEATURE_FLAGS.map((f) => {
    const base = {
      key: f.key, label: f.label, category: f.category, kind: f.kind,
      valueType: f.valueType, issue: f.issue || '', status: f.status,
      description: f.description, defaultValue: asStr(f.default),
      rawDbValue: null, rawEnvValue: null,
    };
    try {
      if (f.kind === 'constant') {
        return {
          ...base, effectiveValue: asStr(f.default), enabled: Number(f.default) > 0,
          winningLayer: 'constant', howToChangeText: 'Not runtime-configurable (hardcoded).',
        };
      }

      if (f.kind === 'env') {
        const raw = envRaw(f.envVar);
        const enabled = f.envRule === 'numeric'
          ? Number(raw ?? f.default) > 0
          : envBool(raw, f.envRule);
        const effective = f.envRule === 'numeric' ? asStr(raw ?? f.default) : String(enabled);
        return {
          ...base, rawEnvValue: raw, effectiveValue: effective, enabled,
          winningLayer: raw !== null ? 'env' : 'default',
          howToChangeText: renderHowTo(f),
        };
      }

      // db-setting
      const row = rowByEntity[f.entity];
      const rawDb = row ? asStr(row[f.column]) : null;
      let enabled;
      let winningLayer;
      if (f.resolver === 'chat') {
        // Chat booleans have no env layer: DB row wins, else CDS default.
        const dbVal = row ? row[f.column] : undefined;
        enabled = dbVal === undefined || dbVal === null ? Boolean(f.default) : Boolean(dbVal);
        winningLayer = dbVal === undefined || dbVal === null ? 'default' : 'db';
      } else {
        const resolved = resolvedByResolver[f.resolver];
        if (resolved == null) throw new Error(`${f.resolver} resolver unavailable`);
        enabled = Boolean(resolved[f.column]);
        // Precedence: db if row column set, else env if env var set, else default.
        const envHit = envRaw(deriveEnvVar(f)) !== null;
        winningLayer = rawDb !== null ? 'db' : envHit ? 'env' : 'default';
        base.rawEnvValue = envRaw(deriveEnvVar(f));
      }
      return {
        ...base, rawDbValue: rawDb, effectiveValue: String(enabled), enabled,
        winningLayer, howToChangeText: renderHowTo(f),
      };
    } catch (err) {
      LOG.warn(`flag ${f.key} resolution failed`, err.message);
      return {
        ...base, effectiveValue: 'error', enabled: false, winningLayer: 'unknown',
        howToChangeText: renderHowTo(f),
      };
    }
  });
}

/** The env var backing a kg/uiEvents db-setting, for winningLayer detection. */
function deriveEnvVar(f) {
  if (f.entity === 'UiEventsSettings') return 'UI_EVENTS_ENABLED';
  if (f.column === 'enabled') return 'KNOWLEDGE_GRAPH_ENABLED';
  if (f.column === 'onDemandExtractionEnabled') return 'KG_ONDEMAND_ENABLED';
  return '';
}

function renderHowTo(f) {
  const h = f.howToChange;
  if (!h) return 'Not runtime-configurable (hardcoded).';
  if (h.method === 'cf-env') return h.command;
  if (h.method === 'admin-tile') {
    return `Admin UI → ${h.tile} tile (${h.hash})${h.note ? ` — ${h.note}` : ''}`;
  }
  return '';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feature-flags/resolve.js test/unit/feature-flags-registry.test.js
git commit -m "feat(#feature-flags): resolveFeatureFlags with layered state + fail-quiet"
```

---

## Task 3: `FeatureFlags` entity + READ handler

**Files:**
- Modify: `srv/admin-service.cds` (add entity near the other `@readonly` entities, e.g. after `TimeZones`)
- Modify: `srv/admin-service.js` (add `on('READ', 'FeatureFlags')`)

**Interfaces:**
- Consumes: `resolveFeatureFlags()` from Task 2.
- Produces: OData entity `AdminService.FeatureFlags` (key `key`), served read-only under `/admin/`.

- [ ] **Step 1: Add the entity to `srv/admin-service.cds`**

Find the `@readonly entity TimeZones as projection on ims.TimeZones;` line and add below it:

```cds
  // Feature Flag Viewer (#feature-flags). Unbacked read-only entity; rows are
  // synthesized in srv/admin-service.js on('READ') from
  // srv/lib/feature-flags/resolve.js. No DB table.
  @readonly
  @cds.persistence.skip
  @Capabilities: { InsertRestrictions: { Insertable: false }, UpdateRestrictions: { Updatable: false }, DeleteRestrictions: { Deletable: false } }
  entity FeatureFlags {
    key key         : String(120);
    label           : String(120);
    category        : String(60);
    kind            : String(20);
    valueType       : String(20);
    issue           : String(20);
    status          : String(20);
    description     : String(500);
    effectiveValue  : String(60);
    enabled         : Boolean;
    winningLayer    : String(20);
    rawDbValue      : String(120);
    rawEnvValue     : String(120);
    defaultValue    : String(60);
    howToChangeText : String(500);
  }
```

- [ ] **Step 2: Add the READ handler to `srv/admin-service.js`**

At the top of the file, add the import alongside the existing imports:

```js
const { resolveFeatureFlags } = require('./lib/feature-flags/resolve.js');
```

Note: check whether `srv/admin-service.js` is ESM (`import`) or CJS (`require`). If it uses `import`, use `import { resolveFeatureFlags } from './lib/feature-flags/resolve.js';` instead. Match the file.

Inside the service implementation function (where other `this.on(...)` / `this.after(...)` handlers are registered), add:

```js
  // Feature Flag Viewer (#feature-flags): synthesize rows from the registry.
  this.on('READ', 'FeatureFlags', async () => {
    return resolveFeatureFlags();
  });
```

- [ ] **Step 3: Boot CAP and verify the entity serves**

Run: `npx cds serve --in-memory 2>&1 | head -30` in one shell, then in another:
`curl -s http://localhost:4004/admin/FeatureFlags | head -c 400`
(If auth blocks it locally, use `cds watch` with mocked auth, or verify via the Task 4 integration test instead.)
Expected: JSON with a `value` array containing `KG_PAGERANK_ENABLED` etc. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js
git commit -m "feat(#feature-flags): FeatureFlags read-only entity + READ handler"
```

---

## Task 4: Integration test for the READ handler

**Files:**
- Test: `test/unit/feature-flags-service.test.js` (create)

**Interfaces:**
- Consumes: the running `AdminService` via `cds.test`.

- [ ] **Step 1: Write the failing integration test**

Create `test/unit/feature-flags-service.test.js`. Mirror an existing `cds.test`-based unit test in `test/unit/` for the exact bootstrap idiom (auth user, base URL). Template:

```js
const cds = require('@sap/cds');
const { GET, expect } = cds.test(__dirname + '/../..');

describe('AdminService.FeatureFlags', () => {
  it('returns registry rows with resolved state', async () => {
    const { data } = await GET('/admin/FeatureFlags', {
      auth: { username: 'admin', password: 'admin' }, // match repo's mocked-auth creds
    });
    expect(data.value.length).to.be.greaterThan(10);
    const pr = data.value.find((r) => r.key === 'KG_PAGERANK_ENABLED');
    expect(pr).to.exist;
    expect(pr).to.have.property('winningLayer');
    expect(pr).to.have.property('howToChangeText');
  });
});
```

If the repo's unit tests use Vitest `expect` rather than chai from `cds.test`, adapt assertions to the neighbor file's style. Check `test/unit/` first.

- [ ] **Step 2: Run to verify it fails or passes**

Run: `npx vitest run test/unit/feature-flags-service.test.js`
Expected: PASS if Task 3 is correct (the endpoint already serves). If it fails on auth, align the auth block with an existing admin-service unit test.

- [ ] **Step 3: Commit**

```bash
git add test/unit/feature-flags-service.test.js
git commit -m "test(#feature-flags): integration test for FeatureFlags READ"
```

---

## Task 5: Fiori Elements app

**Files:**
- Create: `app/admin/featureFlags/webapp/Component.js`
- Create: `app/admin/featureFlags/webapp/manifest.json`
- Create: `app/admin/featureFlags/webapp/i18n/i18n.properties`
- Modify: `app/admin-annotations.cds` (add `FeatureFlags` UI annotations)

**Interfaces:**
- Consumes: `AdminService.FeatureFlags` at `/admin/`.

- [ ] **Step 1: Create `Component.js`**

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.featureFlags.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 2: Create `i18n/i18n.properties`**

```properties
appTitle=Feature Flags
appSubtitle=Live state of runtime feature flags
```

- [ ] **Step 3: Create `manifest.json`**

Mirror `app/admin/kgCommunities/webapp/manifest.json`, retargeted to `FeatureFlags`. The `sap.app.id` last segment MUST be `featureFlags` (matches the folder for the shell generator).

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.featureFlags",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appSubtitle}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {}, "sap.m": {}, "sap.ui.core": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.featureFlags.i18n.i18n" }
      }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "FeatureFlagsList", "target": "FeatureFlagsList" },
        { "pattern": "FeatureFlags({key}):?query:", "name": "FeatureFlagObjectPage", "target": "FeatureFlagObjectPage" }
      ],
      "targets": {
        "FeatureFlagsList": {
          "type": "Component",
          "id": "FeatureFlagsList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "contextPath": "/FeatureFlags",
              "variantManagement": "Page",
              "initialLoad": "Enabled",
              "navigation": {
                "FeatureFlags": { "detail": { "route": "FeatureFlagObjectPage" } }
              }
            }
          }
        },
        "FeatureFlagObjectPage": {
          "type": "Component",
          "id": "FeatureFlagObjectPage",
          "name": "sap.fe.templates.ObjectPage",
          "options": {
            "settings": { "contextPath": "/FeatureFlags", "editableHeaderContent": false }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Add UI annotations to `app/admin-annotations.cds`**

Append (the `Criticality` uses the `$edmJson $If` idiom already used for `Tutorials.isolated` at line ~601, driven by `enabled`):

```cds
annotate AdminService.FeatureFlags with @UI: {
  HeaderInfo: {
    TypeName: 'Feature Flag', TypeNamePlural: 'Feature Flags',
    Title: { Value: label },
    Description: { Value: key }
  },
  SelectionFields: [ category, enabled, status, kind ],
  LineItem: [
    { Value: label },
    { Value: category },
    {
      $Type: 'UI.DataField', Value: enabled, Label: 'State',
      Criticality: { $edmJson: { $If: [ { $Path: 'enabled' }, 3, 1 ] } }
    },
    { Value: effectiveValue, Label: 'Effective' },
    { Value: winningLayer, Label: 'Source' },
    { Value: status },
    { Value: issue }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'General', Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Resolution', Label: 'Resolution', Target: '@UI.FieldGroup#Resolution' },
    { $Type: 'UI.ReferenceFacet', ID: 'HowTo', Label: 'How to change', Target: '@UI.FieldGroup#HowTo' }
  ],
  FieldGroup#General: { Data: [
    { Value: key }, { Value: label }, { Value: category },
    { Value: kind }, { Value: valueType }, { Value: status }, { Value: issue },
    { Value: description }
  ]},
  FieldGroup#Resolution: { Data: [
    {
      $Type: 'UI.DataField', Value: enabled, Label: 'State',
      Criticality: { $edmJson: { $If: [ { $Path: 'enabled' }, 3, 1 ] } }
    },
    { Value: effectiveValue, Label: 'Effective value' },
    { Value: winningLayer, Label: 'Winning layer' },
    { Value: rawDbValue, Label: 'Raw DB value' },
    { Value: rawEnvValue, Label: 'Raw env value' },
    { Value: defaultValue, Label: 'Default value' }
  ]},
  FieldGroup#HowTo: { Data: [
    { Value: howToChangeText, Label: 'How to change' }
  ]}
};
```

- [ ] **Step 5: Verify annotations compile**

Run: `npx cds compile srv/admin-service.cds --to edmx 2>&1 | tail -5`
Expected: no errors (EDMX emitted or silent success).

- [ ] **Step 6: Commit**

```bash
git add app/admin/featureFlags app/admin-annotations.cds
git commit -m "feat(#feature-flags): Fiori Elements viewer app + UI annotations"
```

---

## Task 6: Shell wiring (nav entry + route maps)

**Files:**
- Modify: `app/admin-shell/webapp/model/navigation.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`

**Interfaces:**
- Consumes: the `featureFlags` app folder from Task 5 (generator auto-builds the manifest componentUsage/route/target from it).

- [ ] **Step 1: Add nav entry**

In `app/admin-shell/webapp/model/navigation.json`, add to the `runtimeSettings` group's `items` array (after `tenant`):

```json
        { "key": "featureFlags", "title": "Feature Flags", "requiredScope": "Admin" }
```

- [ ] **Step 2: Add route + title map entries**

In `app/admin-shell/webapp/controller/Shell.controller.js`, add to `NAV_KEY_TO_ROUTE` (alongside `uiEvents: "uiEvents",`):

```js
    featureFlags: "featureFlags",
```

Find `NAV_KEY_TO_TITLE` (starts ~line 59) and add the matching title entry:

```js
    featureFlags: "Feature Flags",
```

- [ ] **Step 3: Regenerate the shell manifest and verify the component wired**

Run: `npm run build --prefix app/admin-shell 2>&1 | tail -20` (or the repo's admin-shell build script — check `app/admin-shell/package.json` scripts).
Then grep the generated manifest:
`grep -c "featureFlags" app/admin-shell/webapp/manifest.json`
Expected: ≥1 (componentUsage + route + target present). If the generator throws a collision, check the prefix (first two letters `fe`) isn't already taken in `admin-shell-overrides.js`; if so, add a `prefix` override there.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json app/admin-shell/webapp/controller/Shell.controller.js
git commit -m "feat(#feature-flags): register Feature Flags tile in admin shell nav"
```

---

## Task 7: Drift test (anti-rot guarantee)

**Files:**
- Test: `test/unit/feature-flags-registry.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `FEATURE_FLAGS`; the filesystem under `srv/`; the CDS model.

- [ ] **Step 1: Write the failing drift test**

Append to `test/unit/feature-flags-registry.test.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirnameFF = path.dirname(fileURLToPath(import.meta.url));
const SRV_DIR = path.resolve(__dirnameFF, '../../srv');

// Env vars that are intentionally NOT feature flags (infra/tuning). Each MUST
// carry a comment justifying the exclusion.
const ENV_IGNORE = new Set([
  'KG_WCC_ISOLATION_THRESHOLD',            // numeric admin-tunable threshold, not on/off
  'KG_RETIRE_ORPHANS_AGE_DAYS',            // grace-period tuning knob
  'KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD', // advisory nudge threshold
  'KG_PAGERANK_ALPHA',                     // blend-strength tuning knob
  'KG_MERGE_SIM_THRESHOLD',                // similarity tuning
  'KG_MERGE_SIM_THRESHOLD_EXTRACT',        // similarity tuning
  'KG_EXTRACT_BUILD_CAP',                  // batch-size tuning
  // NOTE: on-by-default kill switches (METRICS_ENABLED, MCP_*_ENABLED,
  // KG_RETIRE_ORPHANS_ENABLED, KG_STEP_SLICER_ENABLED,
  // COMMUNITY_BLOGS_CLASSIFIER_ENABLED, HOMEPAGE_NEWS_RELEVANCE_ENABLED)
  // ARE registered in registry.js — do NOT ignore them here.
]);

function walkJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

describe('feature-flag registry drift', () => {
  it('every process.env feature-flag var is registered or ignored', () => {
    const registered = new Set(FEATURE_FLAGS.filter((f) => f.kind === 'env').map((f) => f.envVar));
    const pattern = /process\.env\.([A-Z][A-Z0-9_]*(?:_ENABLED|_WEIGHT))\b/g;
    const discovered = new Set();
    for (const file of walkJs(SRV_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      let m;
      while ((m = pattern.exec(src))) discovered.add(m[1]);
    }
    const missing = [...discovered].filter((v) => !registered.has(v) && !ENV_IGNORE.has(v));
    expect(missing, `Unregistered env flags: ${missing.join(', ')}`).toEqual([]);
  });
});
```

Note: this test registers the on-by-default kill switches. That means Task 1's
registry MUST also include entries for `METRICS_ENABLED`, `MCP_AUTH_ENABLED`,
`MCP_PAT_MINT_ENABLED`, `MCP_PHASE3_ENABLED`, `MCP_RESOURCES_ENABLED`,
`MCP_PROMPTS_ENABLED`, `MCP_ADMIN_TOOLS_ENABLED`, `KG_RETIRE_ORPHANS_ENABLED`,
`KG_STEP_SLICER_ENABLED`, `COMMUNITY_BLOGS_CLASSIFIER_ENABLED`,
`HOMEPAGE_NEWS_RELEVANCE_ENABLED` (all `envRule: 'false-disables'`, `default: true`,
`status: 'ga'`). Add them in this step to make the drift test pass — this is the
one place the registry's completeness is enforced.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: FAIL — lists the unregistered `*_ENABLED` kill switches.

- [ ] **Step 3: Add the missing kill-switch descriptors to `registry.js`**

Append to `FEATURE_FLAGS` in `srv/lib/feature-flags/registry.js`. Example for two; add all listed in Step 1's note:

```js
  {
    key: 'METRICS_ENABLED', label: 'Metrics collection', category: 'Observability',
    kind: 'env', envVar: 'METRICS_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '', status: 'ga',
    description: 'Prometheus-style metrics. Kill switch — set false to disable.',
    howToChange: cfEnv('METRICS_ENABLED', 'false'),
  },
  {
    key: 'MCP_PHASE3_ENABLED', label: 'MCP Phase-3 compose router', category: 'MCP',
    kind: 'env', envVar: 'MCP_PHASE3_ENABLED', envRule: 'false-disables',
    valueType: 'boolean', default: true, issue: '', status: 'ga',
    description: 'MCP resources/prompts/admin compose router. Kill switch.',
    howToChange: cfEnv('MCP_PHASE3_ENABLED', 'false'),
  },
  // ... MCP_AUTH_ENABLED, MCP_PAT_MINT_ENABLED, MCP_RESOURCES_ENABLED,
  // MCP_PROMPTS_ENABLED, MCP_ADMIN_TOOLS_ENABLED, KG_RETIRE_ORPHANS_ENABLED,
  // KG_STEP_SLICER_ENABLED, COMMUNITY_BLOGS_CLASSIFIER_ENABLED,
  // HOMEPAGE_NEWS_RELEVANCE_ENABLED — same shape, false-disables/default true.
```

Before finalizing, confirm each var's actual polarity by grepping its read site
(e.g. `grep -rn "MCP_AUTH_ENABLED" srv/`) — if a var uses `=== 'true'` it is
`true-enables`/`default false`, not a kill switch.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/feature-flags/registry.js test/unit/feature-flags-registry.test.js
git commit -m "test(#feature-flags): drift test + register kill-switch flags"
```

---

## Task 8: Full test sweep + docs pointer

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (add a one-line pointer) — optional if the repo prefers CLAUDE.md; check convention.

- [ ] **Step 1: Run the unit suite**

Run: `npm test`
Expected: PASS, including the three new feature-flag test files. Fix any failures before proceeding.

- [ ] **Step 2: Add a docs pointer**

Add a bullet to `docs/developers/reference/tutorials-ims-gotchas.md` under an appropriate section:

```markdown
- **Feature Flag Viewer** (`/admin-ui/#featureFlags`) — read-only tile listing every
  runtime feature flag's live resolved state (effective value, winning layer,
  raw db/env/default). Source of truth: `srv/lib/feature-flags/registry.js`; a
  drift test (`test/unit/feature-flags-registry.test.js`) fails the build when a
  new `*_ENABLED`/`*_WEIGHT` env var or settings boolean is added unregistered.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/reference/tutorials-ims-gotchas.md
git commit -m "docs(#feature-flags): pointer to Feature Flag Viewer + registry"
```

- [ ] **Step 4: Push and open a draft PR**

```bash
git push -u origin worktree-feature-flag-viewer
gh pr create --draft --title "feat: Admin feature-flag viewer" \
  --body "Read-only Admin UI tile listing every feature flag's live resolved state (effective value, winning layer, raw db/env/default) + how-to-change guidance. Backed by a hand-authored registry with a drift test. Design: docs/superpowers/specs/2026-07-15-feature-flag-viewer-design.md"
```

---

## Self-Review

**Spec coverage:**
- Read-only viewer → Tasks 3–6 (no write handlers). ✓
- Registry + drift test → Tasks 1, 7. ✓
- Resolved value + winning layer + raw values → Task 2 (`resolve.js`), Task 5 (Resolution FieldGroup). ✓
- All flags incl. on-by-default → Task 1 + Task 7 kill switches. ✓
- FE ListReport + ObjectPage → Task 5. ✓
- Shell wiring (navigation.json + NAV maps + generated manifest) → Task 6. ✓
- Fail-quiet error handling → Task 2 error sentinel + test. ✓
- `KG_WEIGHT` as constant → Task 1 descriptor + Task 2 constant branch + test. ✓
- Serving-instance note → covered in spec §6; the UI subtitle "Live state of runtime feature flags" plus the `winningLayer` column convey it. ✓

**Type consistency:** `resolveFeatureFlags()` row shape (Task 2 Interfaces) matches the `FeatureFlags` entity elements (Task 3) and the annotation `Value:` paths (Task 5). `resolver` enum `'kg'|'uiEvents'|'chat'` consistent across Task 1 test, Task 1 registry, Task 2 `resolvedByResolver`. `winningLayer` values `'db'|'env'|'default'|'constant'|'unknown'` consistent between Task 2 impl and tests.

**Placeholder scan:** No TBDs. The one deferred detail — the exact list of kill-switch descriptors — is fully enumerated in Task 7 Step 1's note with shapes and a verification grep, not left vague.

**Open verification points flagged for the implementer** (not placeholders — real environment checks): (a) `srv/admin-service.js` ESM-vs-CJS import style; (b) repo's `cds.test` auth creds for Task 4; (c) admin-shell build script name for Task 6; (d) each kill-switch var's true polarity via grep before registering.
