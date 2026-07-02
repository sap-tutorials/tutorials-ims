// scripts/__tests__/resync-tutorial-meta-from-ims.test.ts
//
// Unit tests for buildResyncDecision — the pure diff/decision function
// that drives scripts/resync-tutorial-meta-from-ims.cjs. Kind-agnostic
// (no HANA). Exercises every bucket + edge case.
//
// Full context in the header of the target script itself.
//
// Contract:
//   input:  imsRow = { TUT_LEGACY_ID, OWNER_NAME, OWNER_EMAIL }
//   output: decision.newOwner       ← imsRow.OWNER_NAME (trimmed, or null)
//           decision.newOwnerEmail  ← imsRow.OWNER_EMAIL (with @noreply.github.com
//                                     resolution via githubLoginToEmail map,
//                                     @sap-tutorials.local nulled)
// These are TWO INDEPENDENT signals — legacy Java IMS's admin UI renders
// A.NAME as the "Owner" column display; CAP's MyTutorialsRaw source-3 joins
// on ownerEmail while source-4 joins on owner (name). Preserving both
// widens the matched-user set.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildResyncDecision, tutorialUuid } = require('../resync-tutorial-meta-from-ims.cjs');

const uuidFor = (legacyId: number) => tutorialUuid(legacyId);

describe('buildResyncDecision — owner name/email split', () => {
  it('bucket=no-target-row when DEV has no matching TutorialMeta', () => {
    const imsRow = { TUT_LEGACY_ID: 15733, OWNER_NAME: 'Riley Rainey',
                     OWNER_EMAIL: 'riley.rainey@sap.com' };
    const d = buildResyncDecision(imsRow, null);
    expect(d.bucket).toBe('no-target-row');
    expect(d.targetTutorialUuid).toBe(uuidFor(15733));
    expect(d.newOwner).toBe('Riley Rainey');
    expect(d.newOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.currentOwner).toBeNull();
    expect(d.currentOwnerEmail).toBeNull();
  });

  it('bucket=already-matches when DEV and IMS agree (identical name + email)', () => {
    const imsRow = { TUT_LEGACY_ID: 5580, OWNER_NAME: 'John Currie',
                     OWNER_EMAIL: 'john.currie@sap.com' };
    const devRow = {
      ID: 'dev-uuid', TUTORIAL_ID: uuidFor(5580),
      OWNER: 'John Currie', OWNEREMAIL: 'john.currie@sap.com',
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=already-matches ignores email case (owner name is case-sensitive though)', () => {
    // owner NAME is what Java IMS renders — we preserve its exact case.
    // ownerEmail is case-insensitive per RFC 5321.
    const imsRow = { TUT_LEGACY_ID: 1, OWNER_NAME: 'Admin User',
                     OWNER_EMAIL: 'Admin.User@Sap.com' };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(1),
      OWNER: 'Admin User', OWNEREMAIL: 'admin.user@sap.com',
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=already-matches when both IMS and DEV are NULL', () => {
    const imsRow = { TUT_LEGACY_ID: 2, OWNER_NAME: null, OWNER_EMAIL: null };
    const devRow = {
      ID: 'y', TUTORIAL_ID: uuidFor(2),
      OWNER: null, OWNEREMAIL: null,
    };
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('bucket=will-overwrite when IMS OWNER_NAME is present + OWNER_EMAIL is a noreply that does not resolve — writes NAME but NULL email', () => {
    // Exactly Riley's live-IMS row: NAME="Riley Rainey", EMAIL=noreply placeholder.
    // With no githubLoginToEmail map, ownerEmail null-outs but owner keeps
    // "Riley Rainey" — MyTutorialsRaw source-4 join on firstName+lastName
    // then fires for Riley.
    const imsRow = {
      TUT_LEGACY_ID: 15733,
      OWNER_NAME: 'Riley Rainey',
      OWNER_EMAIL: '10248021+rbrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'meta-uuid', TUTORIAL_ID: uuidFor(15733),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwner).toBe('Riley Rainey');
    expect(d.newOwnerEmail).toBeNull();
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('bucket=will-overwrite when IMS reassigned to different owner (name + email both change)', () => {
    const imsRow = { TUT_LEGACY_ID: 5580, OWNER_NAME: 'John Currie',
                     OWNER_EMAIL: 'john.currie@sap.com' };
    const devRow = {
      ID: 'meta-uuid', TUTORIAL_ID: uuidFor(5580),
      OWNER: 'Riley Rainey', OWNEREMAIL: 'riley.rainey@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.currentOwner).toBe('Riley Rainey');
    expect(d.newOwner).toBe('John Currie');
    expect(d.currentOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.newOwnerEmail).toBe('john.currie@sap.com');
  });

  it('bucket=will-overwrite when IMS NAME + EMAIL both go NULL (stale DEV needs clearing)', () => {
    const imsRow = { TUT_LEGACY_ID: 3, OWNER_NAME: null, OWNER_EMAIL: null };
    const devRow = {
      ID: 'z', TUTORIAL_ID: uuidFor(3),
      OWNER: 'Stale Owner', OWNEREMAIL: 'stale@sap.com',
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwner).toBeNull();
    expect(d.newOwnerEmail).toBeNull();
  });

  it('IMS OWNER_NAME with only whitespace is treated as NULL', () => {
    const imsRow = { TUT_LEGACY_ID: 4, OWNER_NAME: '   ',
                     OWNER_EMAIL: 'user@sap.com' };
    const devRow = {
      ID: 'w', TUTORIAL_ID: uuidFor(4),
      OWNER: null, OWNEREMAIL: 'user@sap.com',
    };
    // Only OWNER_EMAIL survives; NAME is whitespace so it's normalized to null.
    // DEV agrees (owner=null, email=user@sap.com), so this becomes already-matches.
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('@sap-tutorials.local bots null-out ownerEmail but do not affect newOwner', () => {
    const imsRow = { TUT_LEGACY_ID: 5, OWNER_NAME: 'Someone',
                     OWNER_EMAIL: 'bot@sap-tutorials.local' };
    const devRow = {
      ID: 'v', TUTORIAL_ID: uuidFor(5),
      OWNER: 'Someone', OWNEREMAIL: null,
    };
    // owner='Someone' matches, ownerEmail null == null. Should be already-matches.
    expect(buildResyncDecision(imsRow, devRow).bucket).toBe('already-matches');
  });

  it('targetTutorialUuid is deterministic across identical inputs', () => {
    const a = buildResyncDecision(
      { TUT_LEGACY_ID: 15733, OWNER_NAME: 'A', OWNER_EMAIL: 'x@y.z' }, null
    );
    const b = buildResyncDecision(
      { TUT_LEGACY_ID: 15733, OWNER_NAME: 'B', OWNER_EMAIL: 'other@y.z' }, null
    );
    expect(a.targetTutorialUuid).toBe(b.targetTutorialUuid);
    expect(a.targetTutorialUuid).toBe(uuidFor(15733));
  });
});

describe('buildResyncDecision — @users.noreply.github.com resolution via githubLogin map', () => {
  it('resolves modern <userid>+<login>@ noreply — Riley case', () => {
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 15733, OWNER_NAME: 'Riley Rainey',
      OWNER_EMAIL: '10248021+rbrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(15733),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.bucket).toBe('will-overwrite');
    // Both signals populate: owner from NAME, ownerEmail from noreply resolution.
    expect(d.newOwner).toBe('Riley Rainey');
    expect(d.newOwnerEmail).toBe('riley.rainey@sap.com');
    expect(d.resolvedFromNoreply).toBe(true);
  });

  it('resolves legacy bare-login <login>@ noreply', () => {
    const map = new Map([['legacyuser', 'legacy.user@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 42, OWNER_NAME: 'Legacy User',
      OWNER_EMAIL: 'legacyuser@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(42),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.newOwnerEmail).toBe('legacy.user@sap.com');
    expect(d.newOwner).toBe('Legacy User');
    expect(d.resolvedFromNoreply).toBe(true);
  });

  it('login lookup is case-insensitive', () => {
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 15733, OWNER_NAME: 'Riley Rainey',
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

  it('unresolved noreply -> newOwnerEmail null, newOwner still populated from NAME', () => {
    // This is the important case: even if the noreply lookup fails, the
    // NAME signal survives — MyTutorialsRaw source-4 can still match.
    const map = new Map();
    const imsRow = {
      TUT_LEGACY_ID: 99, OWNER_NAME: 'Unknown Author',
      OWNER_EMAIL: '99999+unknownlogin@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(99),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.bucket).toBe('will-overwrite');
    expect(d.newOwner).toBe('Unknown Author');
    expect(d.newOwnerEmail).toBeNull();
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('resolvedFromNoreply=false for a plain corporate email', () => {
    const map = new Map([['rbrainey', 'riley.rainey@sap.com']]);
    const imsRow = {
      TUT_LEGACY_ID: 5580, OWNER_NAME: 'John Currie',
      OWNER_EMAIL: 'john.currie@sap.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(5580),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow, map);
    expect(d.newOwner).toBe('John Currie');
    expect(d.newOwnerEmail).toBe('john.currie@sap.com');
    expect(d.resolvedFromNoreply).toBe(false);
  });

  it('null githubLoginToEmail argument is safe (defaults to empty Map)', () => {
    const imsRow = {
      TUT_LEGACY_ID: 300, OWNER_NAME: 'Riley Rainey',
      OWNER_EMAIL: '10248021+rbrainey@users.noreply.github.com',
    };
    const devRow = {
      ID: 'x', TUTORIAL_ID: uuidFor(300),
      OWNER: null, OWNEREMAIL: null,
    };
    const d = buildResyncDecision(imsRow, devRow);
    expect(d.newOwner).toBe('Riley Rainey');  // NAME still survives
    expect(d.newOwnerEmail).toBeNull();       // noreply unresolved without map
    expect(d.resolvedFromNoreply).toBe(false);
  });
});
