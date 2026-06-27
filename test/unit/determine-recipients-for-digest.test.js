import { describe, it, expect } from 'vitest';
import { determineRecipientsForDigest } from '../../srv/lib/contributor-notifications.js';

const baseDigest = (tutorials, worstLevel, authorEmail = 'alice@sap.com') => ({
  authorEmail, authorSource: 'Tutorials.author', authorName: 'Alice',
  tutorials, worstLevel, worstReviewedDate: '2024-01-01',
});

describe('determineRecipientsForDigest', () => {
  it('level 0 → to=author, cc=[]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 0);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual([]);
  });

  it('level 1 → to=author, cc=[repoOwner]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 1);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual(['repo@sap.com']);
  });

  it('level 2 → to=author, cc=[repoOwner, ...admins], deduped', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 2);
    const { to, cc } = determineRecipientsForDigest(d, ['admin1@sap.com', 'admin2@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).toEqual(['repo@sap.com', 'admin1@sap.com', 'admin2@sap.com']);
  });

  it('level 3 → to=admins, cc=[]', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 3);
    const { to, cc } = determineRecipientsForDigest(d, ['admin@sap.com']);
    expect(to).toEqual(['admin@sap.com']);
    expect(cc).toEqual([]);
  });

  it('dedupes repo owner across multiple tutorials', () => {
    const d = baseDigest([
      { tutorialId: 1, repoOwner: 'repo@sap.com' },
      { tutorialId: 2, repoOwner: 'repo@sap.com' },
      { tutorialId: 3, repoOwner: 'other-repo@sap.com' },
    ], 1);
    const { cc } = determineRecipientsForDigest(d, []);
    expect(cc).toEqual(['repo@sap.com', 'other-repo@sap.com']);
  });

  it('drops cc entry that duplicates to (author also in admin list)', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'repo@sap.com' }], 2, 'alice@sap.com');
    const { to, cc } = determineRecipientsForDigest(d, ['alice@sap.com', 'admin@sap.com']);
    expect(to).toEqual(['alice@sap.com']);
    expect(cc).not.toContain('alice@sap.com');
    expect(cc).toContain('admin@sap.com');
  });

  it('case-insensitive cc dedupe vs to', () => {
    const d = baseDigest([{ tutorialId: 1, repoOwner: 'REPO@sap.com' }], 1, 'alice@sap.com');
    const { cc } = determineRecipientsForDigest(d, ['Repo@SAP.com']);
    expect(cc).toHaveLength(1);
  });

  it('null repoOwner is skipped', () => {
    const d = baseDigest([
      { tutorialId: 1, repoOwner: null },
      { tutorialId: 2, repoOwner: 'repo@sap.com' },
    ], 1);
    const { cc } = determineRecipientsForDigest(d, []);
    expect(cc).toEqual(['repo@sap.com']);
  });
});
