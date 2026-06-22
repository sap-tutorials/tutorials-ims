/**
 * Unit tests for #385 PR-2 — the three new mapRow helpers + one backfill helper.
 * Pattern mirrors test/scripts/migrate-from-hana.test.js (pure-function tests
 * against named exports).
 *
 * Spec: docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 */
import { describe, it, expect } from 'vitest';
import { mapTagRow, mapTutorialContributorRow, mapTutorialRepositoryRow } from '../../scripts/migrate-from-hana.js';
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

  // Regression tests for the TITLE_PATH bug (2026-06-22). Tom caught this on
  // /admin-ui/#tags-display where the "Full Path" column was empty for all
  // 10,523 rows — the original migrator's SELECT omitted TITLE_PATH so the
  // column was never populated even though it exists on IMS Java Tag.titlePath.
  it('emits TITLEPATH from the IMS TITLE_PATH source column', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'sap-s-4hana', SEMAPHORE_ID: 's', TITLE_PATH: 'software-product>sap-s-4hana', IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out.TITLEPATH).toBe('software-product>sap-s-4hana');
  });

  it('passes null TITLE_PATH through unchanged (CAP-side column is nullable)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', TITLE_PATH: null, IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out.TITLEPATH).toBeNull();
  });

  it('truncates TITLEPATH at 255 chars (CAP column width)', () => {
    const longPath = 'a>'.repeat(200);  // 400 chars
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', TITLE_PATH: longPath, IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out.TITLEPATH.length).toBe(255);
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

describe('mapTutorialRepositoryRow() (#385 PR-2)', () => {
  // The contributorMap is what main() builds from `SELECT "ID" FROM IMS_TUTORIAL_AUTHOR`.
  // Test fixtures inject a controlled map so we don't depend on real source data.
  const contributorMap = new Map([
    [10, uuidv5('10', NAMESPACES.tutorialcontributor)],
    [11, uuidv5('11', NAMESPACES.tutorialcontributor)],
  ]);

  it('derives deterministic UUID from legacyId via tutorialrepository namespace', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.ID).toBe(uuidv5('5', NAMESPACES.tutorialrepository));
  });

  it('resolves REPOSITORYOWNER_ID via the contributor map', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBe(uuidv5('10', NAMESPACES.tutorialcontributor));
  });

  it('emits REPOSITORYOWNER_ID: null when source REPOSITORY_OWNER_ID is null', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: null },
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBeNull();
  });

  it('emits REPOSITORYOWNER_ID: null when REPOSITORY_OWNER_ID is set but not in contributor map (orphan FK)', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 999 }, // 999 not in map
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBeNull();
  });

  it('passes name through (truncated to 255 chars)', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.NAME).toBe('btp-foundation');
    expect(out.LEGACYID).toBe(5);
  });
});

import backfillModule from '../../scripts/backfill-tutorial-meta-from-ims.cjs';
const { buildBackfillUpdateParams } = backfillModule;

describe('buildBackfillUpdateParams() — backfill row→params (#385 PR-2)', () => {
  it('derives repoUuid via tutorialrepository namespace when REPO_LEGACY_ID is set', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: 'alice@sap.com',
      IS_REVIEWED: 1,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 2,
      NOTIF_DATE: '2026-05-01T00:00:00Z',
      REPO_LEGACY_ID: 42,
    });
    // Expected param order: [owner, reviewedDate, notifNum, notifDate, repoUuid, targetTutorialUuid]
    expect(out.params[4]).toBe(uuidv5('42', NAMESPACES.tutorialrepository));
    expect(out.params[5]).toBe(uuidv5('100', NAMESPACES.tutorial));
    expect(out.skip).toBe(false);
    expect(out.placeholderEmail).toBe(false);
  });

  it('emits null repoUuid when REPO_LEGACY_ID is null', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: 'alice@sap.com',
      IS_REVIEWED: 0,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: null,
    });
    expect(out.params[4]).toBeNull();
  });

  it('does NOT skip a row that has only REPO_LEGACY_ID populated', () => {
    // Defends against the regression where adding the new column to the
    // SELECT but forgetting to extend the early-skip predicate would drop
    // every row that only carries a repository reference.
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: null,  // null/placeholder
      IS_REVIEWED: 0,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: 42,
    });
    expect(out.skip).toBe(false);
    expect(out.params[4]).toBe(uuidv5('42', NAMESPACES.tutorialrepository));
  });

  it('still skips a row with NO useful data at all', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: null,
      IS_REVIEWED: 0,
      UPDATED_AT: null,
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: null,
    });
    expect(out.skip).toBe(true);
  });

  it('flags placeholder emails and emits null for ownerEmail', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: '12345+bob@users.noreply.github.com',
      IS_REVIEWED: 0,
      UPDATED_AT: null,
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: 42,
    });
    expect(out.placeholderEmail).toBe(true);
    expect(out.params[0]).toBeNull();
    expect(out.skip).toBe(false);  // REPO_LEGACY_ID keeps it alive
  });
});
