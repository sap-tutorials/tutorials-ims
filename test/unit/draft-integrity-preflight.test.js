// test/unit/draft-integrity-preflight.test.js
//
// Unit tests for srv/lib/draft-integrity-preflight.js (#2968, rev #2909-fix).
// checkDraftCascadeConstraints now DISCOVERS the real ADMINSERVICE_*_DRAFTS
// tables from SYS.TABLE_COLUMNS, then checks which have an ON DELETE CASCADE
// constraint. The mock dbRun below branches on the SQL to emulate both queries.
// All tests use mock dbRun — no CAP boot required.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkDraftCascadeConstraints,
  DRAFT_TABLES,
  isHanaKind,
  wireDraftIntegrityPreflight,
} from '../../srv/lib/draft-integrity-preflight.js';

// Realistic sample of discovered draft tables (service-prefixed, uppercase).
const DISCOVERED = [
  'ADMINSERVICE_MISSIONS_DRAFTS',
  'ADMINSERVICE_GROUPS_DRAFTS',
  'ADMINSERVICE_TUTORIALS_DRAFTS',
];

// Build a mock dbRun that answers the discovery query with `discovered`
// and the cascade-constraint query with `cascade`.
const makeDbRun = (discovered, cascade) => async (sql) => {
  if (/TABLE_COLUMNS/.test(sql)) {
    return discovered.map((t) => ({ TABLE_NAME: t }));
  }
  if (/REFERENTIAL_CONSTRAINTS/.test(sql)) {
    return cascade.map((t) => ({ TABLE_NAME: t }));
  }
  return [];
};

describe('DRAFT_TABLES (deprecated export)', () => {
  it('is still exported as a non-empty array (legacy import compatibility)', () => {
    expect(Array.isArray(DRAFT_TABLES)).toBe(true);
    expect(DRAFT_TABLES.length).toBeGreaterThan(0);
  });
});

describe('isHanaKind', () => {
  it('returns true when cds.db.options.kind is hana', () => {
    expect(isHanaKind({ db: { options: { kind: 'hana' } } })).toBe(true);
  });
  it('returns false for sqlite', () => {
    expect(isHanaKind({ db: { options: { kind: 'sqlite' } } })).toBe(false);
  });
  it('returns false when cds.db is undefined', () => {
    expect(isHanaKind({})).toBe(false);
  });
  it('returns false when cds itself is empty-ish', () => {
    expect(isHanaKind(null)).toBe(false);
    expect(isHanaKind(undefined)).toBe(false);
  });
});

describe('checkDraftCascadeConstraints', () => {
  it('ok:true when every discovered draft table has a cascade constraint', async () => {
    const result = await checkDraftCascadeConstraints(makeDbRun(DISCOVERED, DISCOVERED));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(DISCOVERED.length);
    expect(result.found).toHaveLength(DISCOVERED.length);
    expect(result.missing).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('ok:false and lists missing when some tables lack the constraint', async () => {
    const result = await checkDraftCascadeConstraints(
      makeDbRun(DISCOVERED, [DISCOVERED[0]])
    );
    expect(result.ok).toBe(false);
    expect(result.total).toBe(DISCOVERED.length);
    expect(result.found).toEqual([DISCOVERED[0]]);
    expect(result.missing).toEqual([DISCOVERED[1], DISCOVERED[2]]);
  });

  it('ok:false with all missing when no constraints exist', async () => {
    const result = await checkDraftCascadeConstraints(makeDbRun(DISCOVERED, []));
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(DISCOVERED.length);
    expect(result.found).toHaveLength(0);
  });

  it('total:0 and ok:true when no draft tables are discovered', async () => {
    // Nothing to validate -> ok (the served handler warns on total===0 separately)
    const result = await checkDraftCascadeConstraints(makeDbRun([], []));
    expect(result.total).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('matches case-insensitively (HANA uppercase vs mixed)', async () => {
    const run = async (sql) => {
      if (/TABLE_COLUMNS/.test(sql)) return [{ TABLE_NAME: 'adminservice_missions_drafts' }];
      if (/REFERENTIAL_CONSTRAINTS/.test(sql)) return [{ TABLE_NAME: 'ADMINSERVICE_MISSIONS_DRAFTS' }];
      return [];
    };
    const result = await checkDraftCascadeConstraints(run);
    expect(result.ok).toBe(true);
    expect(result.found).toEqual(['ADMINSERVICE_MISSIONS_DRAFTS']);
  });

  it('ok:false with error property when dbRun throws (fail-open shape)', async () => {
    const result = await checkDraftCascadeConstraints(async () => {
      throw new Error('HANA gone');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HANA gone');
    expect(result.found).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('treats null rows result as empty (no crash)', async () => {
    const result = await checkDraftCascadeConstraints(async () => null);
    // discovery returned null -> no tables -> total 0, ok true, no throw
    expect(result.total).toBe(0);
    expect(result.ok).toBe(true);
  });
});

describe('wireDraftIntegrityPreflight sentinel', () => {
  let dbRunCalls = 0;

  const makeFakeCds = () => ({
    db: {
      options: { kind: 'hana' },
      run: async () => {
        dbRunCalls++;
        return [];
      },
    },
    on: (event, fn) => {
      if (event === 'served') void fn();
    },
    log: () => ({ warn: () => {}, info: () => {} }),
  });

  beforeEach(() => {
    dbRunCalls = 0;
    delete globalThis.__draftIntegrityPreflightRegistered;
  });
  afterEach(() => {
    delete globalThis.__draftIntegrityPreflightRegistered;
  });

  it('registers only once when called twice (globalThis sentinel)', async () => {
    const fakeCds = makeFakeCds();
    wireDraftIntegrityPreflight(fakeCds);
    wireDraftIntegrityPreflight(fakeCds);
    await new Promise((r) => setTimeout(r, 0));
    // One served handler -> at most the two discovery+constraint queries for ONE run
    expect(dbRunCalls).toBeLessThanOrEqual(2);
  });

  it('skips the DB query entirely when kind is not hana', async () => {
    const fakeCds = makeFakeCds();
    fakeCds.db.options.kind = 'sqlite';
    wireDraftIntegrityPreflight(fakeCds);
    await new Promise((r) => setTimeout(r, 0));
    expect(dbRunCalls).toBe(0);
  });
});
