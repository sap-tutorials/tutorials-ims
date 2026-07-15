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
        expect(['kg', 'uiEvents', 'chat']).toContain(f.resolver);
      }
    }
  });

  it('keys are unique', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

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
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
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
    vi.doMock('@sap/cds', () => ({ default: { entities: () => ({}), log: () => ({ warn() {}, info() {}, error() {}, debug() {} }) } }));
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
