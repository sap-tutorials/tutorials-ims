// test/unit/teched-normalize.test.js
import { describe, it, expect } from 'vitest';
import {
  computeContentHash,
  generateSlug,
  toKebabSlug,
  normalizeSession,
  normalizeSpeaker,
  normalizeTrack,
} from '../../srv/lib/teched/normalize.js';

describe('computeContentHash', () => {
  it('is stable for identical input', () => {
    const a = { title: 'CAP', venue: 'BERLIN', room: 'Hall 3' };
    expect(computeContentHash(a)).toBe(computeContentHash({ ...a }));
  });

  it('is order-independent across keys', () => {
    const a = { title: 'CAP', venue: 'BERLIN', room: 'Hall 3' };
    const b = { room: 'Hall 3', venue: 'BERLIN', title: 'CAP' };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('is order-independent across array element order', () => {
    const a = { speakerSourceIds: ['spk-2', 'spk-1'] };
    const b = { speakerSourceIds: ['spk-1', 'spk-2'] };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('changes when a source value changes', () => {
    const a = { title: 'CAP' };
    const b = { title: 'CAP (updated)' };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it('treats undefined and null the same (no shape churn)', () => {
    expect(computeContentHash({ a: undefined })).toBe(computeContentHash({ a: null }));
  });
});

describe('generateSlug', () => {
  it('kebab-cases and dedups with -2/-3 suffixes', () => {
    const seen = new Set();
    expect(generateSlug('DEV101', seen)).toBe('dev101');
    expect(generateSlug('DEV101', seen)).toBe('dev101-2');
    expect(generateSlug('DEV101', seen)).toBe('dev101-3');
  });

  it('collapses non-alphanumerics and trims', () => {
    expect(toKebabSlug('  Build Cloud-Native Apps! ')).toBe('build-cloud-native-apps');
  });

  it('falls back to "item" for empty input', () => {
    expect(generateSlug('', new Set())).toBe('item');
  });
});

describe('normalize* row shape', () => {
  it('normalizeSession carries transport fields and hashes source only', () => {
    const seen = new Set();
    const row = normalizeSession(
      { sourceId: 's1', venue: 'VIRTUAL', sessionCode: 'DEV101', title: 'T', speakerSourceIds: ['b', 'a'], trackSourceId: 'trk' },
      seen,
    );
    expect(row.slug).toBe('dev101');
    expect(row.sourceId).toBe('s1');
    expect(row.speakerSourceIds).toEqual(['b', 'a']);
    expect(row.contentHash).toHaveLength(64);
    // slug is NOT part of the hash: same source with a forced different slug hashes identically
    const row2 = normalizeSession(
      { sourceId: 's1', venue: 'VIRTUAL', sessionCode: 'DEV101', title: 'T', speakerSourceIds: ['a', 'b'], trackSourceId: 'trk' },
      new Set(),
      'some-other-slug',
    );
    expect(row2.contentHash).toBe(row.contentHash);
    expect(row2.slug).toBe('some-other-slug');
  });

  it('normalizeSpeaker / normalizeTrack produce slug + 64-char hash', () => {
    const sp = normalizeSpeaker({ sourceId: 'spk-1', name: 'Ada Byron' }, new Set());
    expect(sp.slug).toBe('ada-byron');
    expect(sp.contentHash).toHaveLength(64);
    const tr = normalizeTrack({ sourceId: 'trk-ai', name: 'Artificial Intelligence', venue: 'VIRTUAL' }, new Set());
    expect(tr.slug).toBe('artificial-intelligence');
    expect(tr.contentHash).toHaveLength(64);
  });

  it('normalizeSession carries the allDay flag (issue #2392)', () => {
    const timed = normalizeSession({ sourceId: 's1', sessionCode: 'DEV1', title: 'T' }, new Set());
    // missing/undefined allDay is a stable false, never undefined
    expect(timed.allDay).toBe(false);
    const allday = normalizeSession(
      { sourceId: 's2', sessionCode: 'GARAGE', title: 'Developer Garage', allDay: true },
      new Set(),
    );
    expect(allday.allDay).toBe(true);
    // allDay is part of the content hash: flipping it re-hashes
    const flipped = normalizeSession(
      { sourceId: 's2', sessionCode: 'GARAGE', title: 'Developer Garage', allDay: false },
      new Set(),
    );
    expect(flipped.contentHash).not.toBe(allday.contentHash);
  });
});
