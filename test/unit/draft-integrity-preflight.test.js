// test/unit/draft-integrity-preflight.test.js
//
// Unit tests for srv/lib/draft-integrity-preflight.js (#2968).
// All tests use mock dbRun — no CAP boot required.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkDraftCascadeConstraints,
  DRAFT_TABLES,
  isHanaKind,
  wireDraftIntegrityPreflight,
} from '../../srv/lib/draft-integrity-preflight.js';

describe('DRAFT_TABLES', () => {
  it('is a non-empty array of lowercase strings', () => {
    expect(Array.isArray(DRAFT_TABLES)).toBe(true);
    expect(DRAFT_TABLES.length).toBeGreaterThan(0);
    for (const t of DRAFT_TABLES) {
      expect(typeof t).toBe('string');
      expect(t).toBe(t.toLowerCase());
    }
  });

  it('contains the known high-risk draft tables', () => {
    // These are the tables mentioned in the runbook. If a new draft-enabled
    // entity is added to AdminService and this test fails, add it to DRAFT_TABLES.
    expect(DRAFT_TABLES).toContain('com_sap_developers_ims_missions_drafts');
    expect(DRAFT_TABLES).toContain('com_sap_developers_ims_groups_drafts');
    expect(DRAFT_TABLES).toContain('com_sap_developers_ims_tutorials_drafts');
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
  it('returns ok:true when all DRAFT_TABLES have a cascade constraint', async () => {
    const allRows = DRAFT_TABLES.map(t => ({ TABLE_NAME: t.toUpperCase() }));
    const result = await checkDraftCascadeConstraints(async () => allRows);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.found).toHaveLength(DRAFT_TABLES.length);
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false when no constraints exist', async () => {
    const result = await checkDraftCascadeConstraints(async () => []);
    expect(result.ok).toBe(false);
    expect(result.found).toHaveLength(0);
    expect(result.missing).toHaveLength(DRAFT_TABLES.length);
  });

  it('returns ok:false and lists only missing tables when partial', async () => {
    const partial = [{ TABLE_NAME: DRAFT_TABLES[0].toUpperCase() }];
    const result = await checkDraftCascadeConstraints(async () => partial);
    expect(result.ok).toBe(false);
    expect(result.found).toHaveLength(1);
    expect(result.found[0]).toBe(DRAFT_TABLES[0]);
    expect(result.missing).toHaveLength(DRAFT_TABLES.length - 1);
    expect(result.missing).not.toContain(DRAFT_TABLES[0]);
  });

  it('handles case-insensitive TABLE_NAME matching', async () => {
    // HANA returns uppercase; we store lowercase — ensure the comparison works
    const rows = DRAFT_TABLES.map(t => ({ TABLE_NAME: t.toUpperCase() }));
    const result = await checkDraftCascadeConstraints(async () => rows);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with error property when dbRun throws (fail-open shape)', async () => {
    const result = await checkDraftCascadeConstraints(async () => { throw new Error('HANA gone'); });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HANA gone');
    expect(result.found).toHaveLength(0);
    expect(result.missing).toHaveLength(DRAFT_TABLES.length);
  });

  it('treats null/undefined rows result as empty (no crash)', async () => {
    const result = await checkDraftCascadeConstraints(async () => null);
    expect(result.ok).toBe(false);
    expect(result.found).toHaveLength(0);
  });
});

describe('wireDraftIntegrityPreflight sentinel', () => {
  let dbRunCalls = 0;

  const makeFakeCds = () => ({
    db: {
      options: { kind: 'hana' },
      run: async () => { dbRunCalls++; return []; },
    },
    on: (event, fn) => { if (event === 'served') void fn(); },
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
    // One microtask tick to let async handler settle
    await new Promise(r => setTimeout(r, 0));
    expect(dbRunCalls).toBeLessThanOrEqual(1);
  });

  it('skips the DB query entirely when kind is not hana', async () => {
    const fakeCds = makeFakeCds();
    fakeCds.db.options.kind = 'sqlite';
    wireDraftIntegrityPreflight(fakeCds);
    await new Promise(r => setTimeout(r, 0));
    expect(dbRunCalls).toBe(0);
  });
});
