import { describe, it, expect } from 'vitest';
import { groupNotificationsByAuthor } from '../../srv/lib/contributor-notifications.js';

function n({ tutorialId, slug, title = 'T', level = 0,
             reviewedDate = '2025-01-01T00:00:00.000Z',
             lastNotificationDate = null, contributors = [], repoOwner = null,
             authorUserEmail = null, authorUserName = null }) {
  return {
    tutorialId, slug, title,
    reviewedDate,
    notificationLevel: level,
    lastNotificationDate,
    contributors, repoOwner, authorUserEmail, authorUserName
  };
}

describe('groupNotificationsByAuthor', () => {
  it('groups 5 tutorials across 3 authors + 1 unresolvable', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'alice@sap.com', authorUserName: 'Alice', level: 1 }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'alice@sap.com', authorUserName: 'Alice', level: 2,
          reviewedDate: '2024-09-01T00:00:00.000Z' }),
      n({ tutorialId: 3, slug: 't3', contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }], level: 0 }),
      n({ tutorialId: 4, slug: 't4', contributors: [{ name: 'Carol', email: 'carol@sap.com', role: 'AUTHOR' }], level: 3 }),
      n({ tutorialId: 5, slug: 't5' }), // no FK, no contributors → unresolvable
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(4);

    const alice = digests.find(d => d.authorEmail === 'alice@sap.com');
    expect(alice.authorSource).toBe('Tutorials.author');
    expect(alice.authorName).toBe('Alice');
    expect(alice.tutorials).toHaveLength(2);
    expect(alice.worstLevel).toBe(2);
    expect(alice.worstReviewedDate).toBe('2024-09-01T00:00:00.000Z');

    const bob = digests.find(d => d.authorEmail === 'bob@sap.com');
    expect(bob.authorSource).toBe('TutorialContributors');

    const orphan = digests.find(d => d.authorEmail === null);
    expect(orphan.authorSource).toBe('none');
    expect(orphan.tutorials).toHaveLength(1);
  });

  it('case-insensitive grouping — FK and contributor email differing only in case converge', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'Alice@Sap.com', authorUserName: 'Alice' }),
      n({ tutorialId: 2, slug: 't2', contributors: [{ name: 'Alice', email: 'alice@sap.com', role: 'OWNER' }] }),
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(1);
    expect(digests[0].authorEmail).toBe('alice@sap.com');
    expect(digests[0].tutorials).toHaveLength(2);
  });

  it('FK with null/empty email falls through to contributors', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: '', authorUserName: 'Alice',
          contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }] }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: null,
          contributors: [{ name: 'Bob', email: 'bob@sap.com', role: 'OWNER' }] }),
    ];
    const digests = groupNotificationsByAuthor(input);
    expect(digests).toHaveLength(1);
    expect(digests[0].authorEmail).toBe('bob@sap.com');
    expect(digests[0].authorSource).toBe('TutorialContributors');
  });

  it('contributors OWNER role wins over AUTHOR', () => {
    const input = [n({ tutorialId: 1, slug: 't1', contributors: [
      { name: 'A', email: 'author@sap.com', role: 'AUTHOR' },
      { name: 'O', email: 'owner@sap.com', role: 'OWNER' },
    ] })];
    expect(groupNotificationsByAuthor(input)[0].authorEmail).toBe('owner@sap.com');
  });

  it('falls back to AUTHOR when no OWNER present', () => {
    const input = [n({ tutorialId: 1, slug: 't1', contributors: [
      { name: 'A', email: 'author@sap.com', role: 'AUTHOR' },
      { name: 'C', email: 'contrib@sap.com', role: 'CONTRIBUTOR' },
    ] })];
    expect(groupNotificationsByAuthor(input)[0].authorEmail).toBe('author@sap.com');
  });

  it('worstLevel = max across tutorials', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'a@sap.com', level: 0 }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'a@sap.com', level: 3 }),
      n({ tutorialId: 3, slug: 't3', authorUserEmail: 'a@sap.com', level: 1 }),
    ];
    expect(groupNotificationsByAuthor(input)[0].worstLevel).toBe(3);
  });

  it('worstReviewedDate = min (oldest) across tutorials', () => {
    const input = [
      n({ tutorialId: 1, slug: 't1', authorUserEmail: 'a@sap.com', reviewedDate: '2025-03-01T00:00:00.000Z' }),
      n({ tutorialId: 2, slug: 't2', authorUserEmail: 'a@sap.com', reviewedDate: '2024-12-15T00:00:00.000Z' }),
    ];
    expect(groupNotificationsByAuthor(input)[0].worstReviewedDate).toBe('2024-12-15T00:00:00.000Z');
  });

  it('empty input → empty array', () => {
    expect(groupNotificationsByAuthor([])).toEqual([]);
  });
});
