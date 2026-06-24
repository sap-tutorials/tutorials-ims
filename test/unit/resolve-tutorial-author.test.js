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

  it('empty contributors → ownerEmail falls through', () => {
    const emailToUserId = new Map([['owner@sap.com', 'user-owner']]);
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: 'owner@sap.com',
      emailToUserId,
    });
    expect(result.authorUserId).toBe('user-owner');
    expect(result.contributorUserIds).toEqual([]);
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
