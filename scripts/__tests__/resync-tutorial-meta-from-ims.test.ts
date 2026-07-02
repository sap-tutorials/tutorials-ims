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

describe('buildResyncDecision — @users.noreply.github.com resolution (#862 PR C)', () => {
  it('resolves modern <userid>+<login>@ noreply via githubLogin map — Riley case', () => {
    // Exactly the scenario from live IMS: tutorial 15733 owned by
    // 10248021+rbrainey@users.noreply.github.com. With DEV.Users.githubLogin
    // = 'rbrainey' and Users.email = 'riley.rainey@sap.com', the resync
    // resolves to Riley's corporate email — which is what Sage's
    // MyOwnedTutorials keys on.
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 15733,
      OWNER_EMAIL: '10248021+rbrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(15733),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.newOwner).toBe('riley.rainey@sap.com');
    expect(d.resolvedFromNoreply).toBe(true);
  });

  it('resolves legacy bare-login <login>@ noreply via githubLogin map', () => {
    // Pre-2017 GitHub accounts use bare <login>@users.noreply.github.com
    // (no userid-plus prefix). The resolver must handle both shapes.
    const map = new Map([['legacyuser', 'legacy.user@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 42,
      OWNER_EMAIL: 'legacyuser@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(42),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwnerEmail).toBe('legacy.user@sap.com');
    expect(d.resolvedFromNoreply).toBe(true);
  });

  it('login lookup is case-insensitive', () => {
    // GitHub logins are typically lowercase but the map may hold LOWER(TRIM).
    // If the IMS email preserves case ('10248021+RBrainey@...') the resolver
    // must still hit.
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 15733,
      OWNER_EMAIL: '10248021+RBrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(15733),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.newOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.resolvedFromNoreply).toBe(true);
  });

  it('unresolved noreply (login not in map) → newOwnerEmail is null, no-signal', () => {
    // GitHub-noreply for a user who has never logged into DEV via SAP IDP,
    // OR whose Users.githubLogin has not been populated. Fall back to
    // no-signal — do NOT write the placeholder as ownerEmail.
    const map = new Map([['someoneelse', 'someone.else@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 99,
      OWNER_EMAIL: '99999+unknownlogin@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(99),
      OWNER: 'was-something@sap.com', OWNEREMAIL: 'was-something@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwnerEmail).toBeNull();
    expect(d.newOwner).toBeNull();
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('unresolved noreply → already-matches when DEV is also NULL', () => {
    const map = new Map();
    const imsRow = {
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: '12345+ghost@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(100),
      OWNER: null, OWNEREMAIL: null,
    };
    expect(buildResyncDecision(imsRow, devRow, map).bucket).toBe('already-matches');
  });

  it('resolvedFromNoreply is false for non-noreply corporate emails', () => {
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 5580,
      OWNER_EMAIL: 'john.currie@sap.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(5580),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.newOwnerEmail).toBe('john.currie@sap.com');
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('@sap-tutorials.local bots are never resolved via the map — always no-signal', () => {
    // Even if someone with login "bot" existed in Users, this synthetic
    // bot address is not GitHub noreply — the migrator invented it for
    // authors with no email at all. Always treat as no-signal.
    const map = new Map([['bot', 'bot@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 200,
      OWNER_EMAIL: 'sap-tutorials-bot@sap-tutorials.local',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(200),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.newOwnerEmail).toBeNull();
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('null githubLoginToEmail argument is safe (defaults to empty Map)', () => {
    // Backward-compat: existing callers may still pass 2 args. The 3rd arg
    // defaults to an empty Map, which cleanly falls through to no-signal
    // for every noreply address.
    const imsRow = {
      TUT_LEGACY_ID: 300,
      OWNER_EMAIL: '10248021+rbrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(300),
      OWNER: null, OWNEREMAIL: null,
    };
    // No third arg
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.newOwnerEmail).toBeNull();
    expect(d.resolvedFromNoreply).toBe(false);
  });
});
