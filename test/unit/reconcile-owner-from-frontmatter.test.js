// test/unit/reconcile-owner-from-frontmatter.test.js
//
// Unit coverage for the PURE decision logic of
// scripts/reconcile-tutorial-owner-from-frontmatter.cjs — the frontmatter →
// TutorialMeta.owner/ownerEmail + Users.githubLogin reconciliation.
//
// The script's main() does I/O (CAP db, disk frontmatter); these tests target
// only the exported pure functions (buildOwnerDecision, extractGithubLogin),
// which is where the write-policy correctness lives.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildOwnerDecision, extractGithubLogin } =
  require('../../scripts/reconcile-tutorial-owner-from-frontmatter.cjs');

describe('extractGithubLogin', () => {
  it('extracts the login from a github.com profile URL', () => {
    expect(extractGithubLogin('https://github.com/MatthaeusSchuele')).toBe('MatthaeusSchuele');
    expect(extractGithubLogin('https://github.com/julieplummer20')).toBe('julieplummer20');
  });
  it('tolerates trailing path/slash and query', () => {
    expect(extractGithubLogin('https://github.com/MatthaeusSchuele/')).toBe('MatthaeusSchuele');
    expect(extractGithubLogin('github.com/MatthaeusSchuele?tab=repos')).toBe('MatthaeusSchuele');
  });
  it('returns null for non-github, empty, or reserved', () => {
    expect(extractGithubLogin('https://gitlab.com/foo')).toBeNull();
    expect(extractGithubLogin('mailto:x@sap.com')).toBeNull();
    expect(extractGithubLogin('')).toBeNull();
    expect(extractGithubLogin(null)).toBeNull();
    expect(extractGithubLogin('https://github.com/orgs')).toBeNull();
  });
});

describe('buildOwnerDecision — owner (frontmatter wins)', () => {
  const login = { githubLogin: 'MatthaeusSchuele' };
  const user = { email: 'matthaeus.schuele@sap.com', githubLogin: 'MatthaeusSchuele' };

  it('OVERWRITES a wrong owner when frontmatter differs (the Achim→Matthäus case)', () => {
    const d = buildOwnerDecision(
      { owner: 'Achim Seubert', ownerEmail: 'achim.seubert@sap.com' },
      { authorName: 'Matthäus Schüle', ...login },
      user,
    );
    expect(d.ownerAction).toBe('overwrite');
    expect(d.newOwner).toBe('Matthäus Schüle');
    // ownerEmail belonged to the OLD owner (Achim). With the new author (Matthäus)
    // resolvable to a Users row, recompute it to the new email.
    expect(d.ownerEmailAction).toBe('overwrite');
    expect(d.newOwnerEmail).toBe('matthaeus.schuele@sap.com');
  });

  it('on overwrite with an UNRESOLVABLE new author, CLEARS the stale old-owner email', () => {
    // The real prod case today: Users.githubLogin is empty, so the new author's
    // login resolves to no Users row → we must NOT leave Achim's email under
    // Matthäus's name. Null it instead (fillable later once githubLogin seeded).
    const d = buildOwnerDecision(
      { owner: 'Achim Seubert', ownerEmail: 'achim.seubert@sap.com' },
      { authorName: 'Matthäus Schüle', githubLogin: 'MatthaeusSchuele' },
      null, // no matching Users row
    );
    expect(d.ownerAction).toBe('overwrite');
    expect(d.newOwner).toBe('Matthäus Schüle');
    expect(d.ownerEmailAction).toBe('clear');
    expect(d.newOwnerEmail).toBeNull();
  });

  it('on overwrite where the existing email already matches the new author, no-change', () => {
    const d = buildOwnerDecision(
      { owner: 'Old Name', ownerEmail: 'matthaeus.schuele@sap.com' },
      { authorName: 'Matthäus Schüle', ...login },
      user,
    );
    expect(d.ownerAction).toBe('overwrite');
    expect(d.ownerEmailAction).toBe('no-change');
  });

  it('FILLS a NULL owner from frontmatter', () => {
    const d = buildOwnerDecision(
      { owner: null, ownerEmail: null },
      { authorName: 'Matthäus Schüle', ...login },
      user,
    );
    expect(d.ownerAction).toBe('fill');
    expect(d.newOwner).toBe('Matthäus Schüle');
  });

  it('NO-CHANGE when owner already matches frontmatter (idempotency)', () => {
    const d = buildOwnerDecision(
      { owner: 'Matthäus Schüle', ownerEmail: 'matthaeus.schuele@sap.com' },
      { authorName: 'Matthäus Schüle', ...login },
      user,
    );
    expect(d.ownerAction).toBe('no-change');
    expect(d.ownerEmailAction).toBe('no-change');
    expect(d.githubLoginAction).toBe('no-change'); // user already has login
  });

  it('trims whitespace before comparing (no spurious overwrite)', () => {
    const d = buildOwnerDecision(
      { owner: 'Matthäus Schüle', ownerEmail: null },
      { authorName: '  Matthäus Schüle  ', ...login },
      user,
    );
    expect(d.ownerAction).toBe('no-change');
  });

  it('SKIPS when there is no frontmatter author_name (never nulls an existing owner)', () => {
    const d = buildOwnerDecision(
      { owner: 'Someone Existing', ownerEmail: null },
      null,
      null,
    );
    expect(d.ownerAction).toBe('skip-no-frontmatter');
    expect(d.newOwner).toBeNull();
  });
});

describe('buildOwnerDecision — ownerEmail (fill-NULL only)', () => {
  it('FILLS ownerEmail from the resolved Users.email when currently NULL', () => {
    const d = buildOwnerDecision(
      { owner: 'Matthäus Schüle', ownerEmail: null },
      { authorName: 'Matthäus Schüle', githubLogin: 'MatthaeusSchuele' },
      { email: 'matthaeus.schuele@sap.com', githubLogin: 'MatthaeusSchuele' },
    );
    expect(d.ownerEmailAction).toBe('fill');
    expect(d.newOwnerEmail).toBe('matthaeus.schuele@sap.com');
  });

  it('NEVER overwrites a non-null ownerEmail', () => {
    const d = buildOwnerDecision(
      { owner: 'X', ownerEmail: 'stale@sap.com' },
      { authorName: 'X', githubLogin: 'someone' },
      { email: 'fresh@sap.com', githubLogin: 'someone' },
    );
    expect(d.ownerEmailAction).toBe('no-change');
    expect(d.newOwnerEmail).toBeNull();
  });

  it('SKIPS ownerEmail when the login resolves to no Users row', () => {
    const d = buildOwnerDecision(
      { owner: 'X', ownerEmail: null },
      { authorName: 'X', githubLogin: 'unknownlogin' },
      null,
    );
    expect(d.ownerEmailAction).toBe('skip');
  });
});

describe('buildOwnerDecision — Users.githubLogin seeding (fill-NULL only)', () => {
  it('SEEDS githubLogin on a matched user that has none', () => {
    const d = buildOwnerDecision(
      { owner: 'X', ownerEmail: 'x@sap.com' },
      { authorName: 'X', githubLogin: 'MatthaeusSchuele' },
      { email: 'x@sap.com', githubLogin: null },
    );
    expect(d.githubLoginAction).toBe('seed');
    expect(d.seedLogin).toBe('MatthaeusSchuele');
  });

  it('does NOT reseed when the user already has a githubLogin', () => {
    const d = buildOwnerDecision(
      { owner: 'X', ownerEmail: 'x@sap.com' },
      { authorName: 'X', githubLogin: 'MatthaeusSchuele' },
      { email: 'x@sap.com', githubLogin: 'AlreadySet' },
    );
    expect(d.githubLoginAction).toBe('no-change');
  });

  it('SKIPS seeding when there is no matched user', () => {
    const d = buildOwnerDecision(
      { owner: 'X', ownerEmail: null },
      { authorName: 'X', githubLogin: 'MatthaeusSchuele' },
      null,
    );
    expect(d.githubLoginAction).toBe('skip');
  });
});
