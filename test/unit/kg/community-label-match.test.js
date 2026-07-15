// test/unit/kg/community-label-match.test.js
// Pure-function tests for matchLabel (#1173). No DB.
import { describe, it, expect } from 'vitest';
import { matchLabel } from '../../../srv/lib/kg/community-label-match.js';

const LABELS = [
  { communityFingerprint: 'fp-ai',  label: 'SAP AI & Machine Learning', rationale: 'ai stuff' },
  { communityFingerprint: 'fp-rap', label: 'SAP RAP & Fiori Elements',  rationale: 'rap stuff' },
  { communityFingerprint: 'fp-cap', label: 'CAP & Node.js Services',    rationale: 'cap stuff' },
];

describe('matchLabel', () => {
  it('exact case-insensitive match on matchedLabel wins', () => {
    const out = matchLabel({ topic: 'whatever', matchedLabel: 'sap rap & fiori elements', labels: LABELS });
    expect(out.fingerprint).toBe('fp-rap');
    expect(out.label).toBe('SAP RAP & Fiori Elements');
    expect(out.rationale).toBe('rap stuff');
  });

  it('falls back to token overlap on topic when matchedLabel absent', () => {
    const out = matchLabel({ topic: 'show me everything around RAP and fiori', labels: LABELS });
    expect(out.fingerprint).toBe('fp-rap');
  });

  it('falls back to topic when matchedLabel does not exact-match', () => {
    // model hallucinated a label not in the set → ignore it, use topic tokens
    const out = matchLabel({ topic: 'machine learning', matchedLabel: 'Nonexistent Cluster', labels: LABELS });
    expect(out.fingerprint).toBe('fp-ai');
  });

  it('returns no-match for a bare stopword-only topic like "sap"', () => {
    // 'sap' is a stopword (non-discriminating in an all-SAP catalog) → no tokens → no-match
    const out = matchLabel({ topic: 'sap', labels: LABELS });
    expect(out.reason).toBe('no-match');
  });

  it('returns ambiguous when top-2 labels tie on a real shared token', () => {
    // Two labels sharing the non-stopword token "services" tie at score 1.
    const tieLabels = [
      { communityFingerprint: 'fp-cap', label: 'CAP Services',         rationale: 'cap' },
      { communityFingerprint: 'fp-btp', label: 'BTP Platform Services', rationale: 'btp' },
    ];
    const out = matchLabel({ topic: 'services', labels: tieLabels });
    expect(out.reason).toBe('ambiguous');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.map((c) => c.label).sort()).toEqual(
      ['BTP Platform Services', 'CAP Services'].sort()
    );
  });

  it('returns no-match when nothing overlaps', () => {
    const out = matchLabel({ topic: 'quantum knitting', labels: LABELS });
    expect(out.reason).toBe('no-match');
  });

  it('returns no-match on empty labels', () => {
    const out = matchLabel({ topic: 'ai', matchedLabel: 'SAP AI & Machine Learning', labels: [] });
    expect(out.reason).toBe('no-match');
  });
});
