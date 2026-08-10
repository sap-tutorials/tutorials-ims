// scripts/__tests__/migrate-taskrecords-delta.test.ts
//
// Unit tests for the pure decision/mapping logic of
// scripts/migrate-taskrecords-delta.cjs. Kind-agnostic (no HANA).
//
// The critical safety invariants under test:
//   1. Derived UUIDs are deterministic per (entityType, legacyId) — so a
//      re-run upserts the SAME rows and never duplicates.
//   2. partitionByExistence routes rows to update iff their derived PK
//      already exists, insert otherwise — this is what makes the migrator
//      idempotent AND incapable of touching native random-cuid rows.
//   3. mapRow shapes match the target column names the DB expects.
//
// Full context in the header of the target script.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  deriveUuid,
  mapTaskRecordRow,
  mapAccomplishmentRecordRow,
  mapPrizeRecordRow,
  partitionByExistence,
} = require('../migrate-taskrecords-delta.cjs');

describe('deriveUuid — deterministic per (type, legacyId)', () => {
  it('same input produces same UUID', () => {
    expect(deriveUuid('taskrecord', 999)).toBe(deriveUuid('taskrecord', 999));
    expect(deriveUuid('taskrecord', '999')).toBe(deriveUuid('taskrecord', 999)); // stringified
  });

  it('different legacyIds produce different UUIDs', () => {
    expect(deriveUuid('taskrecord', 1)).not.toBe(deriveUuid('taskrecord', 2));
  });

  it('different entity types produce different UUIDs for the same legacyId', () => {
    expect(deriveUuid('taskrecord', 5)).not.toBe(deriveUuid('accomplishmentrecord', 5));
    expect(deriveUuid('user', 5)).not.toBe(deriveUuid('prizerecord', 5));
  });

  it('throws on unknown entity type', () => {
    expect(() => deriveUuid('nope', 1)).toThrow(/No UUID namespace/);
  });

  it('throws on null legacyId', () => {
    expect(() => deriveUuid('taskrecord', null)).toThrow(/null legacyId/);
  });

  it('produces a v5 UUID (deterministic namespace form)', () => {
    // version nibble is '5'
    expect(deriveUuid('taskrecord', 12345)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

describe('mapTaskRecordRow', () => {
  const base = {
    ID: 13600000,
    USER_ID: 42,
    TASK_ID: 5580,
    EVENT_ID: null,
    TASK_TYPE: 'TUTORIAL',
    STATUS: 'COMPLETED',
    COMPLETION_TIME: 1200,
    PROGRESS: 100,
    CONTENT_LANGUAGE: 'en',
    SITE_LANGUAGE: 'en',
    SUBMISSION_ID_STARTED: null,
    SUBMISSION_ID_COMPLETED: null,
    CREATED_AT: '2026-08-01T10:00:00.000Z',
    UPDATED_AT: '2026-08-02T12:00:00.000Z',
  };

  it('derives PK from legacyId and preserves it in LEGACYID', () => {
    const m = mapTaskRecordRow(base, deriveUuid('user', 42), null);
    expect(m.ID).toBe(deriveUuid('taskrecord', 13600000));
    expect(m.LEGACYID).toBe(13600000);
  });

  it('sets COMPLETIONDATE from UPDATED_AT only when status COMPLETED', () => {
    const done = mapTaskRecordRow(base, deriveUuid('user', 42), null);
    expect(done.COMPLETIONDATE).toBe('2026-08-02T12:00:00.000Z');

    const inProg = mapTaskRecordRow({ ...base, STATUS: 'IN_PROGRESS' }, deriveUuid('user', 42), null);
    expect(inProg.COMPLETIONDATE).toBeNull();
  });

  it('passes through the resolved user + event UUIDs verbatim', () => {
    const u = deriveUuid('user', 42);
    const e = deriveUuid('event', 7);
    const m = mapTaskRecordRow({ ...base, EVENT_ID: 7 }, u, e);
    expect(m.USER_ID).toBe(u);
    expect(m.EVENT_ID).toBe(e);
  });

  it('null event resolution leaves EVENT_ID null (nullable FK)', () => {
    const m = mapTaskRecordRow({ ...base, EVENT_ID: 7 }, deriveUuid('user', 42), null);
    expect(m.EVENT_ID).toBeNull();
  });

  it('stamps CREATEDBY/MODIFIEDBY as migration', () => {
    const m = mapTaskRecordRow(base, deriveUuid('user', 42), null);
    expect(m.CREATEDBY).toBe('migration');
    expect(m.MODIFIEDBY).toBe('migration');
  });
});

describe('mapAccomplishmentRecordRow / mapPrizeRecordRow', () => {
  it('accomplishment record maps FKs + AWARDEDAT', () => {
    const m = mapAccomplishmentRecordRow(
      { ID: 500, USER_ID: 42, ACCOMPLISHMENT_ID: 3, DATE: '2026-08-01T00:00:00.000Z' },
      deriveUuid('user', 42),
      deriveUuid('accomplishment', 3)
    );
    expect(m.ID).toBe(deriveUuid('accomplishmentrecord', 500));
    expect(m.USER_ID).toBe(deriveUuid('user', 42));
    expect(m.ACCOMPLISHMENT_ID).toBe(deriveUuid('accomplishment', 3));
    expect(m.AWARDEDAT).toBe('2026-08-01T00:00:00.000Z');
  });

  it('prize record leaves COMPLETIONPATHITEM_ID null and truncates STATUS', () => {
    const m = mapPrizeRecordRow(
      { ID: 900, USER_ID: 42, EVENT_ID: null, PRIZE_ID: 2, STATUS: 'CLAIMED' },
      deriveUuid('user', 42),
      null,
      deriveUuid('prize', 2)
    );
    expect(m.ID).toBe(deriveUuid('prizerecord', 900));
    expect(m.PRIZE_ID).toBe(deriveUuid('prize', 2));
    expect(m.COMPLETIONPATHITEM_ID).toBeNull();
    expect(m.STATUS).toBe('CLAIMED');
  });
});

describe('partitionByExistence — idempotent upsert routing', () => {
  it('routes to update iff derived PK already exists, insert otherwise', () => {
    const a = mapTaskRecordRow(
      { ID: 1, USER_ID: 1, TASK_ID: 1, EVENT_ID: null, TASK_TYPE: 'TUTORIAL', STATUS: 'COMPLETED', COMPLETION_TIME: 0, PROGRESS: 100, CONTENT_LANGUAGE: 'en', SITE_LANGUAGE: 'en', SUBMISSION_ID_STARTED: null, SUBMISSION_ID_COMPLETED: null, CREATED_AT: null, UPDATED_AT: null },
      deriveUuid('user', 1), null
    );
    const b = mapTaskRecordRow(
      { ID: 2, USER_ID: 1, TASK_ID: 1, EVENT_ID: null, TASK_TYPE: 'TUTORIAL', STATUS: 'IN_PROGRESS', COMPLETION_TIME: 0, PROGRESS: 50, CONTENT_LANGUAGE: 'en', SITE_LANGUAGE: 'en', SUBMISSION_ID_STARTED: null, SUBMISSION_ID_COMPLETED: null, CREATED_AT: null, UPDATED_AT: null },
      deriveUuid('user', 1), null
    );
    // a exists in target already, b does not
    const existing = new Set([a.ID]);
    const { inserts, updates } = partitionByExistence([a, b], existing);
    expect(updates.map((r: any) => r.ID)).toEqual([a.ID]);
    expect(inserts.map((r: any) => r.ID)).toEqual([b.ID]);
  });

  it('a native random-cuid PK never collides with a derived PK (safety)', () => {
    // Simulate a native CAP row: a random UUID that is NOT any derivation.
    const nativePk = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const derived = deriveUuid('taskrecord', 13600001);
    expect(nativePk).not.toBe(derived);
    // The native PK is in the existing set, but our mapped row uses the
    // derived PK — so it is routed to INSERT, never touching the native row.
    const m = mapTaskRecordRow(
      { ID: 13600001, USER_ID: 1, TASK_ID: 1, EVENT_ID: null, TASK_TYPE: 'TUTORIAL', STATUS: 'COMPLETED', COMPLETION_TIME: 0, PROGRESS: 100, CONTENT_LANGUAGE: 'en', SITE_LANGUAGE: 'en', SUBMISSION_ID_STARTED: null, SUBMISSION_ID_COMPLETED: null, CREATED_AT: null, UPDATED_AT: null },
      deriveUuid('user', 1), null
    );
    const { inserts, updates } = partitionByExistence([m], new Set([nativePk]));
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('empty input yields empty partitions', () => {
    const { inserts, updates } = partitionByExistence([], new Set());
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });
});
