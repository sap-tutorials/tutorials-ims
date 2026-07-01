// test/unit/resolve-tutorial-author.test.js
// Unit tests for srv/lib/resolve-tutorial-author.js
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
//
// Pure-function tests — no DB, no I/O. Each test builds a small
// Map<lowerEmail, userId> (caller is responsible for normalization) and
// asserts the return shape { authorUserId, contributorUserIds, orphans }.

import { describe, it, expect } from 'vitest';
import { resolveTutorialAuthor } from '../../srv/lib/resolve-tutorial-author.js';

describe('resolveTutorialAuthor (spec 2026-06-24-tutorial-authorship-fk)', () => {
  it('single contributor with role=author + email match → authorUserId is that user', () => {
    const emailToUserId = new Map([['tom@sap.com', 'user-tom']]);
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'tom@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-tom');
    expect(result.contributorUserIds).toEqual([
      { contributorIndex: 0, userId: 'user-tom' },
    ]);
    expect(result.orphans).toEqual([]);
  });

  it('multiple contributors, one with role=author → that one wins', () => {
    const emailToUserId = new Map([
      ['alice@sap.com', 'user-alice'],
      ['bob@sap.com', 'user-bob'],
    ]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: 'alice@sap.com', role: 'contributor' },
        { email: 'bob@sap.com', role: 'author' },
      ],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-bob');
    expect(result.contributorUserIds).toEqual([
      { contributorIndex: 0, userId: 'user-alice' },
      { contributorIndex: 1, userId: 'user-bob' },
    ]);
  });

  it('multiple author roles → stable first-match wins (lowest contributorIndex)', () => {
    const emailToUserId = new Map([
      ['first@sap.com', 'user-first'],
      ['second@sap.com', 'user-second'],
    ]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: 'first@sap.com', role: 'author' },
        { email: 'second@sap.com', role: 'author' },
      ],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-first');
  });

  it('role=owner counts as author candidate (parity with role=author)', () => {
    const emailToUserId = new Map([
      ['alice@sap.com', 'user-alice'],
      ['owner@sap.com', 'user-owner'],
    ]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: 'alice@sap.com', role: 'contributor' },
        { email: 'owner@sap.com', role: 'owner' },
      ],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-owner');
  });

  it('no author/owner role → first contributor (any role) falls through', () => {
    const emailToUserId = new Map([
      ['alice@sap.com', 'user-alice'],
      ['bob@sap.com', 'user-bob'],
    ]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: 'alice@sap.com', role: 'contributor' },
        { email: 'bob@sap.com', role: 'reviewer' },
      ],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-alice');
  });

  it('empty contributors + ownerEmail-only does NOT elevate ownerEmail to author (#862 reopen)', () => {
    // Regression guard: TutorialMeta.ownerEmail encodes monitoring/watchers,
    // NOT authorship. Phase (c) `ownerEmail` fallback was removed because
    // it silently promoted stale monitoring assignments (e.g. legacy IMS
    // migration data) to strict authorship on Tutorials.author_ID.
    const emailToUserId = new Map([['owner@sap.com', 'user-owner']]);
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: 'owner@sap.com',
      emailToUserId,
    });
    expect(result.authorUserId).toBeNull();
    expect(result.source).toBeNull();
    expect(result.contributorUserIds).toEqual([]);
    // Orphan still surfaces the ownerEmail so backfill CSVs can flag it.
    expect(result.orphans.some(o => o.kind === 'tutorial')).toBe(true);
  });

  it('nothing matches → authorUserId null + orphans list', () => {
    const emailToUserId = new Map([['known@sap.com', 'user-known']]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: 'unknown1@sap.com', role: 'author' },
        { email: 'unknown2@sap.com', role: 'contributor' },
      ],
      ownerEmail: 'unknown3@sap.com',
      emailToUserId,
    });
    expect(result.authorUserId).toBeNull();
    expect(result.orphans.length).toBeGreaterThan(0);
    // Every reported orphan must carry kind + email + reason
    for (const o of result.orphans) {
      expect(['contributor', 'tutorial']).toContain(o.kind);
      expect(o).toHaveProperty('email');
      expect(o).toHaveProperty('reason');
    }
  });

  it('case-insensitive matching (Tom.Jung@SAP.com ↔ tom.jung@sap.com)', () => {
    // Caller supplies normalized keys (LOWER+TRIM) per the contract.
    const emailToUserId = new Map([['tom.jung@sap.com', 'user-tom']]);
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'Tom.Jung@SAP.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-tom');
  });

  it('whitespace trim ("  tom@sap.com  " matches "tom@sap.com")', () => {
    const emailToUserId = new Map([['tom@sap.com', 'user-tom']]);
    const result = resolveTutorialAuthor({
      contributors: [{ email: '  tom@sap.com  ', role: 'author' }],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-tom');
  });

  it('empty everything → no throw, authorUserId null', () => {
    const emailToUserId = new Map();
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: null,
      emailToUserId,
    });
    expect(result.authorUserId).toBeNull();
    expect(result.contributorUserIds).toEqual([]);
    expect(Array.isArray(result.orphans)).toBe(true);
  });

  it('null/empty email contributor → not a candidate, no throw', () => {
    const emailToUserId = new Map([['real@sap.com', 'user-real']]);
    const result = resolveTutorialAuthor({
      contributors: [
        { email: null, role: 'author' },
        { email: '', role: 'author' },
        { email: 'real@sap.com', role: 'contributor' },
      ],
      ownerEmail: null,
      emailToUserId,
    });
    // null/empty contributors must NOT be treated as candidates
    expect(result.authorUserId).toBe('user-real');
    // Phase-A: only the real-email contributor produces a contributorUserIds entry
    expect(result.contributorUserIds).toEqual([
      { contributorIndex: 2, userId: 'user-real' },
    ]);
  });
});

describe('resolveTutorialAuthor — Phase 0 (frontmatter)', () => {
  it('frontmatter githubLogin beats every email-based phase', () => {
    // Riley is the most recent committer; Tom is the frontmatter-declared author.
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: 'author' }],
      ownerEmail: 'riley@sap.com',
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: 'jung-thomas',
      loginToUserId: new Map([['jung-thomas', 'USER-TOM']]),
    });
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('frontmatter');
  });

  it('falls through to existing Phase B (a) when frontmatter login is unknown', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: 'ghost-login',
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBe('USER-RILEY');
    expect(result.source).toBe('role-match');
  });

  it('falls through to existing Phase B (b) — any contributor — when no role=author', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: null }],
      ownerEmail: null,
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: null,
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBe('USER-RILEY');
    expect(result.source).toBe('any-contributor');
  });

  it('does NOT fall through to ownerEmail when contributors miss (#862 reopen)', () => {
    // Was Phase (c). Now unset — a tutorial with no frontmatter author, no
    // matching contributor email, and a monitor-only ownerEmail resolves to
    // null so the row's author_ID stays NULL.
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'noone@sap.com' }],
      ownerEmail: 'tom@sap.com',
      emailToUserId: new Map([['tom@sap.com', 'USER-TOM']]),
      frontmatterGithubLogin: null,
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBeNull();
    expect(result.source).toBeNull();
  });

  it('source is null when nothing matches', () => {
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: null,
      emailToUserId: new Map(),
      frontmatterGithubLogin: null,
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBeNull();
    expect(result.source).toBeNull();
  });

  it('login comparison is case-insensitive (Phase 0 normalizes input)', () => {
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: null,
      emailToUserId: new Map(),
      frontmatterGithubLogin: 'Jung-Thomas',  // mixed case
      loginToUserId: new Map([['jung-thomas', 'USER-TOM']]),  // map key is lower
    });
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('frontmatter');
  });

  it('empty/whitespace frontmatterGithubLogin is treated as null', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'tom@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId: new Map([['tom@sap.com', 'USER-TOM']]),
      frontmatterGithubLogin: '   ',
      loginToUserId: new Map([['something', 'someuser']]),
    });
    // Should fall through to Phase B (a) role-match.
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('role-match');
  });

  it('backward-compat: callers that omit frontmatterGithubLogin + loginToUserId still work', () => {
    // This is the call shape used by scripts/backfill-tutorial-authors.cjs today.
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'tom@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId: new Map([['tom@sap.com', 'USER-TOM']]),
    });
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('role-match');
    expect(result.contributorUserIds).toEqual([{ contributorIndex: 0, userId: 'USER-TOM' }]);
  });

  it('emits a frontmatter-login orphan when login is non-null but unresolved', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: 'jung-thomas',
      loginToUserId: new Map(),  // no match
    });
    // Falls through to Phase B (a) — that's still the right behavior
    expect(result.authorUserId).toBe('USER-RILEY');
    expect(result.source).toBe('role-match');
    // But the orphan record tells us frontmatter intent was lost
    const fmOrphan = result.orphans.find(o => o.kind === 'frontmatter-login');
    expect(fmOrphan).toBeDefined();
    expect(fmOrphan.login).toBe('jung-thomas');
    expect(fmOrphan.reason).toContain('frontmatterGithubLogin');
  });
});
