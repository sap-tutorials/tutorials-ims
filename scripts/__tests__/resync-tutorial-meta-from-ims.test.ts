// scripts/__tests__/resync-tutorial-meta-from-ims.test.ts
//
// Unit tests for buildResyncDecision — the pure diff/decision function
// that drives scripts/resync-tutorial-meta-from-ims.cjs. Kind-agnostic
// (no HANA). Exercises every bucket + edge case.
//
// Full context in the header of the target script itself.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildResyncDecision, tutorialUuid } = require('../resync-tutorial-meta-from-ims.cjs');

// Fixed UUIDs for deterministic assertions — the script derives target
// UUIDs via uuidv5(String(legacyId), NAMESPACES.tutorial). We recompute
// them once here so we can assert on decision.targetTutorialUuid without
// hard-coding the namespace.
const uuidFor = (legacyId: number) => tutorialUuid(legacyId);

describe('buildResyncDecision', () => {
  it('bucket=no-target-row when DEV has no matching TutorialMeta', () => {
    const imsRow = { TUT_LEGACY_ID: 15733, OWNER_EMAIL: 'riley.rainey@sap.com' };
    const d = buildResyncDecision(imsRow, null);
    expect(d.bucket).toBe('no-target-row');
    expect(d.targetTutorialUuid).toBe(uuidFor(15733));
    expect(d.newOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.newOwner).toBe('riley.rainey@sap.com');
    expect(d.currentOwner).toBeNull();
    expect(d.currentOwnerEmail).toBeNull();
  });

  it('bucket=already-matches when DEV and IMS agree (identical email)', () => {
    const imsRow = { TUT_LEGACY_ID: 5580, OWNER_EMAIL: 'admin@sap.com' };
    const devRow = {
      ID: 'dev-uuid',
      TUTORIAL_ID: uuidFor(5580),
      OWNER: 'admin@sap.com',
      OWNEREMAIL: 'admin@sap.com',
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=already-matches ignores case', () => {
    const imsRow = { TUT_LEGACY_ID: 1, OWNER_EMAIL: 'Admin@Sap.com' };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(1),
      OWNER: 'admin@sap.com', OWNEREMAIL: 'admin@sap.com',
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=already-matches when both IMS and DEV are NULL (nothing to do)', () => {
    const imsRow = { TUT_LEGACY_ID: 2, OWNER_EMAIL: null };
    const devRow = {
      ID: 'y', TUTORIAL_ID: uuidFor(2),
      OWNER: null, OWNEREMAIL: null,
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=will-overwrite — Riley\'s HXE case (stale DEV vs fresh IMS)', () => {
    // Simulates the exact regression from Riley's reopen: DEV has Riley
    // as owner (Jan-2025 snapshot), IMS today says the tutorial belongs
    // to John Currie (the frontmatter author).
    const imsRow = { TUT_LEGACY_ID: 5580, OWNER_EMAIL: 'john.currie@sap.com' };
    const devRow = {
      ID: 'meta-uuid', TUTORIAL_ID: uuidFor(5580),
      OWNER: 'riley.rainey@sap.com', OWNEREMAIL: 'riley.rainey@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.currentOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.newOwnerEmail).toBe('john.currie@sap.com');
    expect(d.newOwner).toBe('john.currie@sap.com');
  });

  it('bucket=will-overwrite when IMS reassigned to NULL (no clean owner today)', () => {
    // IMS OWNER_ID rows can have OWNER_EMAIL=NULL — the join to IMS_TUTORIAL_
    // AUTHOR returns a row but the author has no email. Full mirror: NULL
    // it out on DEV too, even if DEV still holds a stale non-NULL value.
    const imsRow = { TUT_LEGACY_ID: 3, OWNER_EMAIL: null };
    const devRow = {
      ID: 'z', TUTORIAL_ID: uuidFor(3),
      OWNER: 'stale@sap.com', OWNEREMAIL: 'stale@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwner).toBeNull();
    expect(d.newOwnerEmail).toBeNull();
  });

  it('bucket=will-overwrite when IMS returns a placeholder — treated as no-signal', () => {
    // Same rule as the original backfill: @users.noreply.github.com and
    // @sap-tutorials.local are noise. Under full-mirror this still counts
    // as a change if DEV had a real email before.
    const imsRow = { TUT_LEGACY_ID: 4, OWNER_EMAIL: 'bot@users.noreply.github.com' };
    const devRow = {
      ID: 'w', TUTORIAL_ID: uuidFor(4),
      OWNER: 'real@sap.com', OWNEREMAIL: 'real@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwner).toBeNull();
    expect(d.newOwnerEmail).toBeNull();
  });

  it('bucket=already-matches when both are placeholder-equivalent (both null after filter)', () => {
    const imsRow = { TUT_LEGACY_ID: 5, OWNER_EMAIL: 'bot@sap-tutorials.local' };
    const devRow = {
      ID: 'v', TUTORIAL_ID: uuidFor(5),
      OWNER: null, OWNEREMAIL: null,
    };
    // Placeholder → NULL, matches DEV's NULL → nothing to do.
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('detects a partial-agreement drift as will-overwrite (owner and ownerEmail must both agree)', () => {
    // Unlikely in practice, but the script must not treat "email agrees,
    // owner is different" as already-matches — the invariant the publish
    // path establishes is owner === ownerEmail, and if DEV violates that
    // we still want to correct it.
    const imsRow = { TUT_LEGACY_ID: 6, OWNER_EMAIL: 'x@sap.com' };
    const devRow = {
      ID: 'u', TUTORIAL_ID: uuidFor(6),
      OWNER: 'legacy-free-text-name',   // ← disagrees with x@sap.com
      OWNEREMAIL: 'x@sap.com',
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('will-overwrite');
  });

  it('targetTutorialUuid is deterministic across identical inputs (stable across runs)', () => {
    const a = buildResyncDecision(
      { TUT_LEGACY_ID: 15733, OWNER_EMAIL: 'x@y.z' }, null
    );
    const b = buildResyncDecision(
      { TUT_LEGACY_ID: 15733, OWNER_EMAIL: 'other@y.z' }, null
    );
    expect(a.targetTutorialUuid).toBe(b.targetTutorialUuid);
    expect(a.targetTutorialUuid).toBe(uuidFor(15733));
  });
});
