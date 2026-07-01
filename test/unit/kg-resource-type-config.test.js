// test/unit/kg-resource-type-config.test.js
//
// Tests for the server-owned external-resource type registry (Task 2 of
// #850 KG widget redesign). Verifies the registry shape (6 entries, sparse
// priorities, unique keys) and per-type renderMeta output — the sidebar
// meta-text must match the current Vue template byte-for-byte.

import { describe, it, expect } from 'vitest';
import { RESOURCE_TYPE_CONFIG } from '../../srv/lib/kg-resource-type-config.js';
import {
  formatDate,
  formatLevel,
  formatRelativeMonth,
} from '../../srv/lib/kg-meta-formatters.js';

describe('RESOURCE_TYPE_CONFIG — registry shape', () => {
  it('is an array with exactly 6 entries', () => {
    expect(Array.isArray(RESOURCE_TYPE_CONFIG)).toBe(true);
    expect(RESOURCE_TYPE_CONFIG).toHaveLength(6);
  });

  it('every entry has the required fields with correct types', () => {
    for (const entry of RESOURCE_TYPE_CONFIG) {
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.icon).toBe('string');
      expect(typeof entry.singular).toBe('string');
      expect(typeof entry.plural).toBe('string');
      expect(typeof entry.priority).toBe('number');
      expect(typeof entry.renderMeta).toBe('function');
      expect(typeof entry.metaTemplate).toBe('string');
    }
  });

  it('has no duplicate type keys', () => {
    const types = RESOURCE_TYPE_CONFIG.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('has no duplicate priority values', () => {
    const priorities = RESOURCE_TYPE_CONFIG.map((e) => e.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('priorities are sparse (all divisible by 10)', () => {
    for (const entry of RESOURCE_TYPE_CONFIG) {
      expect(entry.priority % 10).toBe(0);
    }
  });

  it('array is sorted by priority ascending', () => {
    const priorities = RESOURCE_TYPE_CONFIG.map((e) => e.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);
  });

  it('type values are exactly the six expected external types in priority order', () => {
    const types = RESOURCE_TYPE_CONFIG.map((e) => e.type);
    expect(types).toEqual([
      'learning-journey',
      'blog-post',
      'discovery-mission',
      'video',
      'api-doc',
      'sample',
    ]);
  });

  it('every entry has the spec-canonical icon and labels', () => {
    const byType = new Map(RESOURCE_TYPE_CONFIG.map((e) => [e.type, e]));
    expect(byType.get('learning-journey')).toMatchObject({
      icon: '🎓', singular: 'Learning journey', plural: 'Learning journeys',
    });
    expect(byType.get('blog-post')).toMatchObject({
      icon: '📝', singular: 'Blog post', plural: 'Blog posts',
    });
    expect(byType.get('discovery-mission')).toMatchObject({
      icon: '🔍', singular: 'Discovery mission', plural: 'Discovery missions',
    });
    expect(byType.get('video')).toMatchObject({
      icon: '▶️', singular: 'Video', plural: 'Videos',
    });
    expect(byType.get('api-doc')).toMatchObject({
      icon: '📖', singular: 'API reference', plural: 'API references',
    });
    expect(byType.get('sample')).toMatchObject({
      icon: '🧪', singular: 'Sample', plural: 'Samples',
    });
  });
});

// Helper: pluck an entry by type key.
const byType = (t) => RESOURCE_TYPE_CONFIG.find((e) => e.type === t);

describe('renderMeta — learning-journey', () => {
  const { renderMeta } = byType('learning-journey');

  it('renders level + duration', () => {
    const out = renderMeta({ level: 'advanced', durationHours: 12 });
    expect(out.startsWith(' · ')).toBe(true);
    expect(out).toContain('Advanced');
    expect(out).toContain('12h');
  });

  it('renders level only when duration missing', () => {
    const out = renderMeta({ level: 'advanced' });
    expect(out.startsWith(' · ')).toBe(true);
    expect(out).toContain('Advanced');
    expect(out).not.toMatch(/\d+h/);
  });

  it('renders duration only when level missing', () => {
    const out = renderMeta({ durationHours: 12 });
    expect(out.startsWith(' · ')).toBe(true);
    expect(out).toContain('12h');
    expect(out).not.toContain('Advanced');
    expect(out).not.toContain('Beginner');
  });

  it('returns empty string when both fields missing', () => {
    expect(renderMeta({})).toBe('');
  });
});

describe('renderMeta — blog-post', () => {
  const { renderMeta } = byType('blog-post');

  it('renders author + date', () => {
    const out = renderMeta({
      authorName: 'Alice',
      postedAt: '2026-06-03T12:00:00Z',
    });
    expect(out).toContain(' · by Alice');
    expect(out).toContain('Jun 3, 2026');
  });

  it('renders author only when date missing', () => {
    const out = renderMeta({ authorName: 'Alice' });
    expect(out).toContain(' · by Alice');
    expect(out).not.toMatch(/\d{4}/); // no year → no date
  });

  it('renders date only when author missing', () => {
    const out = renderMeta({ postedAt: '2026-06-03T12:00:00Z' });
    expect(out).toContain('Jun 3, 2026');
    expect(out).not.toContain('by');
  });

  it('returns empty string when both fields missing', () => {
    expect(renderMeta({})).toBe('');
  });
});

describe('renderMeta — discovery-mission', () => {
  const { renderMeta } = byType('discovery-mission');

  it('renders effort + category', () => {
    const out = renderMeta({
      effortLevel: 3,
      categoryLabel: 'Integration',
    });
    expect(out).toContain(' · effort 3');
    expect(out).toContain('Integration');
  });

  it('returns empty string when both fields missing', () => {
    expect(renderMeta({})).toBe('');
  });
});

describe('renderMeta — video', () => {
  const { renderMeta } = byType('video');

  it('renders channel + date', () => {
    const out = renderMeta({
      channelTitle: 'SAP Tech Bytes',
      publishedAt: '2026-06-03T12:00:00Z',
    });
    expect(out).toContain(' · by SAP Tech Bytes');
    expect(out).toContain('Jun 3, 2026');
  });

  it('returns empty string when both fields missing', () => {
    expect(renderMeta({})).toBe('');
  });
});

describe('renderMeta — api-doc', () => {
  const { renderMeta } = byType('api-doc');

  it('renders "Official reference" + category when category present', () => {
    const out = renderMeta({ category: 'Business Objects' });
    expect(out.startsWith(' · ')).toBe(true);
    expect(out).toContain('Official reference');
    expect(out).toContain('Business Objects');
  });

  it('renders "Official reference" unconditionally even with empty input', () => {
    const out = renderMeta({});
    expect(out).toContain('Official reference');
  });
});

describe('renderMeta — sample', () => {
  const { renderMeta } = byType('sample');

  it('renders language + stars + last-commit month', () => {
    const out = renderMeta({
      language: 'TypeScript',
      stars: 84,
      lastCommitAt: '2026-06-30T12:00:00Z',
    });
    expect(out).toContain('TypeScript');
    expect(out).toContain('84 stars');
    expect(out).toContain('Updated Jun 2026');
  });

  it('renders language only when stars + lastCommitAt missing', () => {
    const out = renderMeta({ language: 'Python' });
    expect(out).toContain('Python');
    expect(out).not.toContain('stars');
    expect(out).not.toContain('Updated');
  });

  it('returns empty string when all fields missing', () => {
    expect(renderMeta({})).toBe('');
  });
});

// Cross-cutting empty-input contract: only api-doc emits meta on empty input
// (its "Official reference" lead is unconditional per spec). Every other type
// returns '' — the sidebar must not render an orphan ' · ' delimiter.
describe('renderMeta — empty-input contract (non api-doc)', () => {
  const emptyOnly = RESOURCE_TYPE_CONFIG.filter((e) => e.type !== 'api-doc');
  for (const entry of emptyOnly) {
    it(`${entry.type}.renderMeta({}) === ''`, () => {
      expect(entry.renderMeta({})).toBe('');
    });
  }
});

// Reference-value spot-check — pins the formatter contract so a future
// formatter refactor can't silently drift the wire output. Uses the imported
// formatters as the source of truth.
describe('renderMeta — formatter reference values', () => {
  it('learning-journey uses formatLevel for level', () => {
    const out = byType('learning-journey').renderMeta({ level: 'beginner' });
    expect(out).toContain(formatLevel('beginner'));
  });

  it('blog-post uses formatDate for postedAt', () => {
    const iso = '2026-06-03T12:00:00Z';
    const out = byType('blog-post').renderMeta({ postedAt: iso });
    expect(out).toContain(formatDate(iso));
  });

  it('video uses formatDate for publishedAt', () => {
    const iso = '2026-06-03T12:00:00Z';
    const out = byType('video').renderMeta({ publishedAt: iso });
    expect(out).toContain(formatDate(iso));
  });

  it('sample uses formatRelativeMonth for lastCommitAt', () => {
    const iso = '2026-06-30T12:00:00Z';
    const out = byType('sample').renderMeta({ lastCommitAt: iso });
    expect(out).toContain(formatRelativeMonth(iso));
  });
});
