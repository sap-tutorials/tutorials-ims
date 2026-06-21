/**
 * Unit tests for #385 PR-2 — the three new mapRow helpers + one backfill helper.
 * Pattern mirrors test/scripts/migrate-from-hana.test.js (pure-function tests
 * against named exports).
 *
 * Spec: docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 */
import { describe, it, expect } from 'vitest';
import { mapTagRow, mapTutorialContributorRow } from '../../scripts/migrate-from-hana.js';
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

describe('mapTutorialContributorRow() (#385 PR-2)', () => {
  it('derives deterministic UUID from legacyId via tutorialcontributor namespace', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.ID).toBe(uuidv5('7', NAMESPACES.tutorialcontributor));
  });

  it('same legacyId always yields the same UUID (idempotent re-runs)', () => {
    const a = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    const b = mapTutorialContributorRow({ ID: 7, NAME: 'Renamed', EMAIL: 'alice@sap.com' });
    expect(a.ID).toBe(b.ID);
  });

  it('emits TUTORIAL_ID: null (source is flat global table; no per-tutorial FK)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.TUTORIAL_ID).toBeNull();
  });

  it('emits ROLE: null (CAP-side concept; no source counterpart)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.ROLE).toBeNull();
  });

  it('passes name and email through (truncated to 255 chars)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.NAME).toBe('Alice');
    expect(out.EMAIL).toBe('alice@sap.com');
  });

  it('handles null email (source has ~136/385 authors with null EMAIL)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: null });
    expect(out.EMAIL).toBeNull();
  });
});
