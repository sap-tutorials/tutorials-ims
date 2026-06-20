/**
 * Unit tests for the slug-aware partition helper exported by
 * scripts/migrate-from-hana.js. The full migrator depends on @sap/hana-client
 * and live HANA credentials, but the partition logic is a pure function we
 * can exercise directly.
 *
 * Issue #338 — guards against the 2026-06-16 cutover-rehearsal regression
 * where a re-run of the migrator created 123 duplicate Groups (and would have
 * duplicated Tutorials too) by plain-INSERTing rows whose SLUG already lived
 * in the target. The patch mirrors the publish-side LOWER(slug)=? upsert in
 * srv/lib/content-publish-session.js.
 *
 * Issue #466 — additional tests for the four corruption-source fixes from
 * the 2026-06-20 audit:
 *   A. stepOrder normalization (0-based IMS → 1-based CAP)
 *   B. Tutorials.stepCount derivation from stepParentMap
 *   C. CompletionPaths.slug derivation (kebab-case + collision avoidance)
 *   D. NULL-sapId users audit
 */
import { describe, it, expect } from 'vitest';
import {
  partitionBySlug,
  computeTutorialStepCount,
  deriveCompletionPathSlug,
  auditNullSapidUsers,
} from '../../scripts/migrate-from-hana.js';

describe('partitionBySlug()', () => {
  it('partitions rows into inserts (new slugs) and updates (matching slugs)', () => {
    const mapped = [
      { ID: 'new-id-1', SLUG: 'fresh-tutorial', TITLE: 'Fresh' },
      { ID: 'new-id-2', SLUG: 'foo', TITLE: 'New Title' },
    ];
    const existingMap = new Map([['foo', 'existing-id-foo']]);

    const { inserts, updates, passthrough } = partitionBySlug(mapped, existingMap);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].SLUG).toBe('fresh-tutorial');

    expect(updates).toHaveLength(1);
    // The update row's ID must be rewritten to the existing target row's ID
    // so the UPDATE … WHERE "ID" = ? hits the right record. Without this
    // rewrite the UPDATE would silently match zero rows.
    expect(updates[0].ID).toBe('existing-id-foo');
    expect(updates[0].SLUG).toBe('foo');
    expect(updates[0].TITLE).toBe('New Title');

    expect(passthrough).toHaveLength(0);
  });

  it('matches case-insensitively (mixed-case incoming slug vs lowercase existing)', () => {
    const mapped = [
      { ID: 'new-id', SLUG: 'Foo', TITLE: 'New Title' },
    ];
    // existingMap is keyed by the lowercased slug — the lookup logic in
    // migrateEntity calls LOWER(SLUG) on both sides. partitionBySlug
    // lowercases the incoming SLUG before looking it up.
    const existingMap = new Map([['foo', 'existing-id-foo']]);

    const { inserts, updates } = partitionBySlug(mapped, existingMap);

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].ID).toBe('existing-id-foo');
  });

  it('routes rows without a SLUG field to passthrough (no crash)', () => {
    const mapped = [
      { ID: 'a', LEGACYID: 1, TITLE: 'No slug here' },
      { ID: 'b', SLUG: null, TITLE: 'Null slug' },
      { ID: 'c', SLUG: '', TITLE: 'Empty slug' },
      { ID: 'd', SLUG: 'has-slug', TITLE: 'With slug' },
    ];
    const existingMap = new Map();

    const { inserts, updates, passthrough } = partitionBySlug(mapped, existingMap);

    expect(passthrough).toHaveLength(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].SLUG).toBe('has-slug');
    expect(updates).toHaveLength(0);
  });

  it('handles empty input', () => {
    const { inserts, updates, passthrough } = partitionBySlug([], new Map());
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(passthrough).toHaveLength(0);
  });

  it('preserves the existing target row ID and overwrites everything else', () => {
    // Simulates the cutover-rehearsal scenario: a Tutorials row already exists
    // in target with slug='foo' and ID='existing-uuid'. The migrator runs
    // again and produces a payload row with slug='Foo' (mixed case) and the
    // deterministic UUID 'derived-uuid' for that source legacyId. The upsert
    // must:
    //   1. find the existing row by LOWER(slug)
    //   2. preserve its ID (so any FKs already pointing to it survive)
    //   3. carry the new title forward
    const mapped = [
      { ID: 'derived-uuid', LEGACYID: 42, SLUG: 'Foo', TITLE: 'New Title', STATUS: 'ACTIVE' },
    ];
    const existingMap = new Map([['foo', 'existing-uuid']]);

    const { updates } = partitionBySlug(mapped, existingMap);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      ID: 'existing-uuid',     // identity preserved
      SLUG: 'Foo',             // unchanged from input (UPDATE will skip the SLUG column anyway)
      TITLE: 'New Title',      // new value applied
      STATUS: 'ACTIVE',
      LEGACYID: 42,
    });
  });
});

// ─── Issue #466 — corruption-source fixes ───────────────────────────────────

describe('Fix A: step parent → STEPORDER mapping (1-based)', () => {
  // The actual mapping happens inside an inline mapRow closure in main(); we
  // test the same one-liner here to lock the contract: parent.order is the
  // 0-based IMS TASK_ORDER, and we add 1 to land on CAP's 1-based stepOrder.
  // The migrator preserves the `0` fallback for orphan steps (no parent link)
  // so they show up as "broken" rather than colliding with stepOrder=1.
  const stepOrderFor = (parent) => parent?.order != null ? parent.order + 1 : 0;

  it('shifts 0-based IMS TASK_ORDER to 1-based CAP stepOrder', () => {
    expect(stepOrderFor({ order: 0 })).toBe(1);
    expect(stepOrderFor({ order: 4 })).toBe(5);
    expect(stepOrderFor({ order: 99 })).toBe(100);
  });

  it('returns 0 (orphan sentinel) when parent is missing', () => {
    expect(stepOrderFor(undefined)).toBe(0);
    expect(stepOrderFor(null)).toBe(0);
  });

  it('returns 0 when parent exists but order is null', () => {
    expect(stepOrderFor({ order: null })).toBe(0);
    expect(stepOrderFor({ order: undefined })).toBe(0);
  });
});

describe('Fix B: computeTutorialStepCount()', () => {
  it('aggregates step rows by parent tutorial id', () => {
    const stepParentMap = new Map([
      [101, { parentId: 10, order: 0 }],
      [102, { parentId: 10, order: 1 }],
      [103, { parentId: 10, order: 2 }],
      [104, { parentId: 10, order: 3 }],
      [105, { parentId: 10, order: 4 }],
      [201, { parentId: 20, order: 0 }],
      [202, { parentId: 20, order: 1 }],
    ]);
    const counts = computeTutorialStepCount(stepParentMap);
    expect(counts.get(10)).toBe(5);
    expect(counts.get(20)).toBe(2);
    expect(counts.size).toBe(2);
  });

  it('skips orphan rows (parentId null/undefined)', () => {
    const stepParentMap = new Map([
      [101, { parentId: 10, order: 0 }],
      [102, { parentId: null, order: 0 }],
      [103, { parentId: undefined, order: 1 }],
      [104, { parentId: 10, order: 2 }],
    ]);
    const counts = computeTutorialStepCount(stepParentMap);
    expect(counts.get(10)).toBe(2);
    expect(counts.size).toBe(1);
  });

  it('returns empty map for empty input', () => {
    const counts = computeTutorialStepCount(new Map());
    expect(counts.size).toBe(0);
  });
});

describe('Fix C: deriveCompletionPathSlug()', () => {
  it('kebab-cases a normal title', () => {
    const seen = new Set();
    expect(deriveCompletionPathSlug('Hello World', 1, seen)).toBe('hello-world');
  });

  it('strips leading/trailing punctuation and runs of non-alphanum', () => {
    const seen = new Set();
    expect(deriveCompletionPathSlug("  Hello,  World!  ", 1, seen)).toBe('hello-world');
    expect(deriveCompletionPathSlug('SAP S/4HANA', 2, seen)).toBe('sap-s-4hana');
  });

  it('falls back to path-${legacyId} when title is null/empty/whitespace', () => {
    const seen = new Set();
    expect(deriveCompletionPathSlug(null, 99, seen)).toBe('path-99');
    expect(deriveCompletionPathSlug('', 100, seen)).toBe('path-100');
    expect(deriveCompletionPathSlug('   ', 101, seen)).toBe('path-101');
  });

  it('disambiguates collisions inside the same migration pass', () => {
    const seen = new Set();
    expect(deriveCompletionPathSlug('Hello World', 1, seen)).toBe('hello-world');
    expect(deriveCompletionPathSlug('Hello World', 2, seen)).toBe('hello-world-2-1');
    expect(deriveCompletionPathSlug('Hello World', 3, seen)).toBe('hello-world-3-1');
  });

  it('collision-suffixes the fallback path-${legacyId} too', () => {
    const seen = new Set();
    // Pre-seed `path-7` so the empty-title call collides
    seen.add('path-7');
    expect(deriveCompletionPathSlug('', 7, seen)).toBe('path-7-1');
  });
});

describe('Fix D: auditNullSapidUsers()', () => {
  it('writes legacyIds to .migration-data/null-sapid-users.json when rows exist', async () => {
    const writes = [];
    const dirs = [];
    const fakeFs = {
      mkdirSync: (p, opts) => { dirs.push({ p, opts }); },
      writeFileSync: (p, content) => { writes.push({ p, content }); },
    };
    const fakeQuery = async (_src, sql) => {
      // Lock the SQL shape: SELECT ID, UUID FROM IMS_USER WHERE SAP_ID IS NULL
      expect(sql).toContain('IMS_USER');
      expect(sql).toContain('SAP_ID');
      expect(sql).toContain('IS NULL');
      return [
        { ID: 12345, UUID: 'abc-1' },
        { ID: 12346, UUID: 'abc-2' },
      ];
    };
    const result = await auditNullSapidUsers(
      {}, 'IMSDBUSER', fakeQuery, fakeFs, '/fake/cwd'
    );
    expect(result.count).toBe(2);
    expect(result.path).toMatch(/[\\/]\.migration-data[\\/]null-sapid-users\.json$/);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0].content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ ID: 12345, UUID: 'abc-1' });
    // mkdirSync called with recursive: true
    expect(dirs[0].opts).toMatchObject({ recursive: true });
  });

  it('returns count=0 and writes nothing when no rows are returned', async () => {
    const writes = [];
    const fakeFs = {
      mkdirSync: () => { throw new Error('should not be called'); },
      writeFileSync: (p, content) => { writes.push({ p, content }); },
    };
    const fakeQuery = async () => [];
    const result = await auditNullSapidUsers(
      {}, 'IMSDBUSER', fakeQuery, fakeFs, '/fake/cwd'
    );
    expect(result.count).toBe(0);
    expect(result.path).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('captures and returns the error message when query fails (non-fatal)', async () => {
    const fakeFs = { mkdirSync: () => {}, writeFileSync: () => {} };
    const fakeQuery = async () => { throw new Error('table not found'); };
    const result = await auditNullSapidUsers(
      {}, 'IMSDBUSER', fakeQuery, fakeFs, '/fake/cwd'
    );
    expect(result.count).toBe(0);
    expect(result.path).toBeNull();
    expect(result.error).toBe('table not found');
  });
});
