// test/unit/scripts/backfill-tutorial-meta-author.test.js
//
// Tests the pure resolution helper extracted from
// scripts/backfill-tutorial-meta-author.cjs. The script itself is a CJS
// CLI driver; the helper is small enough to import + test cleanly.

import { describe, it, expect } from 'vitest';

// The helper is exported via the script — we import it directly.
// CJS require from ESM-vitest works because the script declares
// module.exports.
const path = require('node:path');
const helperPath = path.resolve(__dirname, '../../../scripts/backfill-tutorial-meta-author.cjs');
const { resolveLegacyOwner } = require(helperPath);

const users = [
  { ID: 'u1', uuid: 'uuid1', email: 'thomas.jung@sap.com', firstName: 'Thomas', lastName: 'Jung' },
  { ID: 'u2', uuid: 'uuid2', email: 'john.smith@sap.com',  firstName: 'John',   lastName: 'Smith' },
  { ID: 'u3', uuid: 'uuid3', email: 'jane.doe@sap.com',    firstName: 'John',   lastName: 'Smith' },  // duplicate name!
];

describe('resolveLegacyOwner', () => {
  it('case 1: email-shape value matches Users.email', () => {
    const r = resolveLegacyOwner('thomas.jung@sap.com', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 2: name-shape value matches Users.firstName + lastName', () => {
    const r = resolveLegacyOwner('Thomas Jung', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 3: compound "Name <email>" extracts the email', () => {
    const r = resolveLegacyOwner('Thomas Jung <thomas.jung@sap.com>', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 4: ambiguous name match — multiple candidates → orphan', () => {
    const r = resolveLegacyOwner('John Smith', users);
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(2);
    expect(r.orphanReason).toBe('ambiguous');
  });

  it('case 5: no match anywhere → orphan', () => {
    const r = resolveLegacyOwner('Unknown Person', users);
    expect(r.match).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.orphanReason).toBe('unmatched');
  });

  it('case 6: null / empty input → orphan (defensive)', () => {
    const r1 = resolveLegacyOwner(null, users);
    expect(r1.match).toBeNull();
    expect(r1.orphanReason).toBe('empty');
    const r2 = resolveLegacyOwner('', users);
    expect(r2.match).toBeNull();
    expect(r2.orphanReason).toBe('empty');
  });
});
