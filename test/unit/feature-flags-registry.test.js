import { describe, it, expect, vi } from 'vitest';
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
        expect(['kg', 'uiEvents', 'chat', 'navigator']).toContain(f.resolver);
      }
    }
  });

  it('keys are unique', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveFeatureFlags precedence + polarity', () => {
  it('db flag (KG_PAGERANK_ENABLED, #2060) reads its declared default when no ImsConfig row exists', async () => {
    vi.resetModules();
    // KG resolvers hit cds; stub them so the module import is side-effect free.
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => ({ enabled: false, onDemandExtractionEnabled: false }),
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    // Empty entities → ImsConfig entity is undefined → the db flag falls back to
    // its declared registry default (false). An env var must NOT influence it.
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');

    process.env.KG_PAGERANK_ENABLED = 'true'; // legacy env var — now inert
    const rows = await resolveFeatureFlags();
    const pr = rows.find((r) => r.key === 'KG_PAGERANK_ENABLED');
    expect(pr.kind).toBe('db');
    expect(pr.enabled).toBe(false);
    expect(pr.winningLayer).toBe('default');
    delete process.env.KG_PAGERANK_ENABLED;
  });

  it('numeric chat db-setting falls back to env when the column is unset (#1171)', async () => {
    vi.resetModules();
    vi.doMock('../../srv/lib/runtime-config/kg-settings.js', () => ({
      resolveKnowledgeGraphSettings: async () => ({ enabled: false, onDemandExtractionEnabled: false }),
    }));
    vi.doMock('../../srv/lib/runtime-config/ui-events-settings.js', () => ({
      resolveUiEventsSettings: async () => ({ enabled: false }),
    }));
    // Empty entities → ChatSettings row is null, so the env var is the fallback layer.
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');

    process.env.KG_COMMUNITY_WEIGHT = '1.5';
    const rows = await resolveFeatureFlags();
    const cw = rows.find((r) => r.key === 'communityRankWeight');
    expect(cw.enabled).toBe(true);
    expect(cw.effectiveValue).toBe('1.5');
    expect(cw.winningLayer).toBe('env');
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
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
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
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
    const { resolveFeatureFlags } = await import('../../srv/lib/feature-flags/resolve.js');
    const rows = await resolveFeatureFlags();
    const kg = rows.find((r) => r.key === 'KNOWLEDGE_GRAPH_ENABLED');
    expect(kg.winningLayer).toBe('unknown');
    expect(kg.effectiveValue).toBe('error');
  });
});

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
  // NOTE (#2060): the on-by-default kill switches (METRICS_ENABLED, MCP_*_ENABLED,
  // KG_RETIRE_ORPHANS_ENABLED, KG_STEP_SLICER_ENABLED,
  // COMMUNITY_BLOGS_CLASSIFIER_ENABLED, HOMEPAGE_NEWS_RELEVANCE_ENABLED) plus
  // KG_PAGERANK_ENABLED, KG_PATH_V2_ENABLED and FRESHNESS_SCAN_ENABLED were
  // migrated from process.env to ImsConfig (kind:'db'). They no longer carry an
  // envVar and are no longer read via process.env, so they neither appear in the
  // scan below nor need an ignore entry here.
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
    // Include any entry that has an envVar (covers db-setting entries with env-layer override
    // such as KNOWLEDGE_GRAPH_ENABLED and UI_EVENTS_ENABLED, not just kind:'env' entries).
    const registered = new Set(FEATURE_FLAGS.filter((f) => f.envVar).map((f) => f.envVar));
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

// ---------------------------------------------------------------------------
// DB-boolean coverage: every Boolean column on a settings entity MUST either
// be registered in FEATURE_FLAGS (entity+column match) or appear in DB_IGNORE.
// This catches the NAV_INCLUDE_NESTED_GROUPS-class miss where bracket-notation
// env reads escape the regex scan above.
//
// Implementation: parse db/schema.cds text to extract entity blocks and their
// Boolean-typed fields. Real CSN loading is avoided to keep the unit project
// side-effect-free (no cds.connect, no DB) — a targeted regex over the CDS
// source is precise enough because the only boolean fields we care about are
// on the small, well-understood settings entities.
// ---------------------------------------------------------------------------

// Settings entities whose Boolean columns are candidates for feature-flag registration.
const SETTINGS_ENTITIES = [
  'ChatSettings',
  'KnowledgeGraphSettings',
  'UiEventsSettings',
  'NavigatorSettings',
  'SearchSettings',     // currently no Boolean columns — loop finds none, test still passes
  'DisplaySettings',    // currently no Boolean columns
  'TenantSettings',     // currently no Boolean columns
];

// Entity.column pairs intentionally NOT registered as feature flags.
// Add only after agreeing this boolean is a non-flag (e.g. an audit/state field).
// Every entry MUST carry a justifying comment.
const DB_IGNORE = new Set([
  // none currently — every known settings boolean is a feature flag
]);

/**
 * Parse db/schema.cds and return a Map<EntityName, string[]> of Boolean field names
 * for each entity in the given set.
 */
function parseSchemaBooleans(schemaPath, targetEntities) {
  const src = fs.readFileSync(schemaPath, 'utf8');
  const result = new Map();

  // Match each `entity <Name> ...{` block up to the closing `}` at column-0.
  // The block body may span many lines; we capture it non-greedily.
  const entityRe = /^entity\s+(\w+)\s[^{]*\{([\s\S]*?)^}/mg;
  let m;
  while ((m = entityRe.exec(src)) !== null) {
    const entityName = m[1];
    if (!targetEntities.includes(entityName)) continue;
    const body = m[2];
    const booleans = [];
    // Match lines like `  fieldName  : Boolean ...;`
    const fieldRe = /^\s+(\w+)\s*:\s*Boolean\b/gm;
    let fm;
    while ((fm = fieldRe.exec(body)) !== null) {
      booleans.push(fm[1]);
    }
    if (booleans.length > 0) result.set(entityName, booleans);
  }
  return result;
}

describe('feature-flag registry DB-boolean coverage', () => {
  it('every Boolean column on a settings entity is registered as a feature flag or in DB_IGNORE', () => {
    const schemaPath = path.resolve(__dirnameFF, '../../db/schema.cds');
    const schemaBooleans = parseSchemaBooleans(schemaPath, SETTINGS_ENTITIES);

    // Build a set of all registered entity.column pairs.
    const registered = new Set(
      FEATURE_FLAGS
        .filter((f) => f.kind === 'db-setting' && f.entity && f.column)
        .map((f) => `${f.entity}.${f.column}`)
    );

    const unregistered = [];
    for (const [entity, cols] of schemaBooleans) {
      for (const col of cols) {
        const key = `${entity}.${col}`;
        if (!registered.has(key) && !DB_IGNORE.has(key)) {
          unregistered.push(key);
        }
      }
    }

    expect(
      unregistered,
      `Unregistered DB Boolean settings columns (add to FEATURE_FLAGS or DB_IGNORE): ${unregistered.join(', ')}`
    ).toEqual([]);
  });
});
