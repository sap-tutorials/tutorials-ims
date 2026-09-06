// test/channels-normalize.test.js
import { describe, it, expect } from 'vitest';
import {
  cleanCitations, normalizeOwnerType, normalizeStatus,
  parseApproxCount, computeContentHash, normalizeChannel,
} from '../srv/lib/channels/normalize.cjs';

describe('channels normalize', () => {
  it('strips [cite:] markers and trailing space', () => {
    expect(cleanCitations('The BTP portal. [cite: 12]')).toBe('The BTP portal.');
    expect(cleanCitations('No marker')).toBe('No marker');
  });

  it('maps owner_type strings to the enum', () => {
    expect(normalizeOwnerType('SAP Official')).toBe('SAP_Official');
    expect(normalizeOwnerType('Community Member')).toBe('Community_Member');
    expect(normalizeOwnerType('unknown junk')).toBeNull();
  });

  it('normalizes status with a carry-over note', () => {
    expect(normalizeStatus('Active')).toEqual({ status: 'Active', note: null });
    expect(normalizeStatus('Entering EOL')).toEqual({ status: 'EOL', note: 'Entering EOL' });
    expect(normalizeStatus('Active (Canonical source)'))
      .toEqual({ status: 'Active', note: 'Canonical source' });
  });

  it('parses approximate counts to integers for the Integer columns', () => {
    expect(parseApproxCount('~1.4K')).toBe(1400);
    expect(parseApproxCount('~3.2K')).toBe(3200);
    expect(parseApproxCount('~520')).toBe(520);
    expect(parseApproxCount('1,234')).toBe(1234);
    expect(parseApproxCount(806)).toBe(806);
    expect(parseApproxCount(null)).toBeNull();
    expect(parseApproxCount('n/a')).toBeNull();
  });

  it('normalizeChannel coerces github_stars/subscribers to integers', () => {
    const row = normalizeChannel({
      id: 'gh-1', name: 'Repo', url: 'https://x',
      github_stars: '~1.4K', subscribers: 806,
    }, '2026-09-03');
    expect(row.githubStars).toBe(1400);
    expect(row.subscribers).toBe(806);
  });

  it('content hash is stable across key order and changes with content', () => {
    const a = computeContentHash({ name: 'X', url: 'u', purpose: 'p' });
    const b = computeContentHash({ url: 'u', purpose: 'p', name: 'X' });
    const c = computeContentHash({ name: 'X', url: 'u', purpose: 'q' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('normalizeChannel produces an upsert-ready row', () => {
    const row = normalizeChannel({
      id: 'portal-001', name: 'BTP Portal', url: 'https://x',
      owner_type: 'SAP Official', isSapOwned: true, status: 'Active',
      focus_areas: ['btp'], tags: ['btp'], purpose: 'Portal. [cite: 1]',
    }, '2026-09-03');
    expect(row.sourceId).toBe('portal-001');
    expect(row.purpose).toBe('Portal.');
    expect(row.ownerType).toBe('SAP_Official');
    expect(row.focusAreas).toEqual(['btp']);
    expect(row.ingestBatch).toBe('2026-09-03');
    expect(typeof row.contentHash).toBe('string');
  });
});
