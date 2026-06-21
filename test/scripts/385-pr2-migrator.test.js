/**
 * Unit tests for #385 PR-2 — the three new mapRow helpers + one backfill helper.
 * Pattern mirrors test/scripts/migrate-from-hana.test.js (pure-function tests
 * against named exports).
 *
 * Spec: docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 */
import { describe, it, expect } from 'vitest';
import { mapTagRow } from '../../scripts/migrate-from-hana.js';
import { v5 as uuidv5 } from 'uuid';
const { NAMESPACES } = await import('../../scripts/lib/migration-uuid-namespaces.cjs');

describe('mapTagRow() — 3 new columns (#385 PR-2)', () => {
  // The legacy ID space matches what tagMap.get() / uuidMap.tags.get() yield.
  const tagUuid = uuidv5('42', NAMESPACES.tag);

  it('emits all 3 new columns when source row carries them', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'sap-s-4hana', SEMAPHORE_ID: 'sem-xyz', IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out).toMatchObject({
      ID: tagUuid,
      LEGACYID: 42,
      NAME: 'sap-s-4hana',
      SEMAPHOREID: 'sem-xyz',
      ISACTUALTAG: true,
      ISINTERESTITEM: true,
    });
  });

  it('handles boolean returned as JS true (not just 1)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', IS_ACTUAL_TAG: true, IS_INTEREST_ITEM: true },
      tagUuid,
    );
    expect(out.ISACTUALTAG).toBe(true);
    expect(out.ISINTERESTITEM).toBe(true);
  });

  it('maps NULL/undefined IS_INTEREST_ITEM to false (Boolean boxed in Java source)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', IS_ACTUAL_TAG: 0, IS_INTEREST_ITEM: null },
      tagUuid,
    );
    expect(out.ISACTUALTAG).toBe(false);
    expect(out.ISINTERESTITEM).toBe(false);
  });

  it('passes null SEMAPHORE_ID through unchanged (CAP-side column is nullable)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: null, IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out.SEMAPHOREID).toBeNull();
  });
});
