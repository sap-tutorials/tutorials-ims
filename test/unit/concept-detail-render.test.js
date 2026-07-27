import { describe, it, expect } from 'vitest';
import { renderConceptDetail } from '../../srv/lib/concept-detail-render.js';

// Task 1 of docs/superpowers/plans/2026-07-08-concepts-scale.md (#1327).
// Pure render function: (concept, phase4, shell) -> { html, gzipped, contentHash }.
// Markup mirrors hugo/layouts/concepts/single.html (concept-page__*,
// concept-card-grid, data-kg-section) — the plan's illustrative sketch used
// bare <h1>; these assertions track the real layout the CAP path must match.

const SHELL = {
  shellHead: '<link rel="stylesheet" href="/css/site.css">',
  shellHeader: '<header>SAP</header>',
  shellFooter: '<footer>© SAP</footer>',
};

const EMPTY_PHASE4 = {
  learningJourneys: [], blogPosts: [], discoveryMissions: [],
  videos: [], apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
};

const EMPTY_REL = { teaches: [], requires: [], requiredBy: [], relatedTo: [] };

describe('renderConceptDetail', () => {
  it('renders a concept with empty phase-4 arrays — omits all optional sections', () => {
    const concept = {
      slug: 'cap',
      name: 'Cloud Application Programming Model',
      description: 'SAP CAP framework.',
      ...EMPTY_REL,
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4, SHELL);
    expect(result.html).toContain('<h1 class="concept-page__title">Cloud Application Programming Model</h1>');
    expect(result.html).toContain('SAP CAP framework.');
    expect(result.html).toContain('<link rel="canonical" href="/concepts/cap/">');
    // Shell fragments injected raw
    expect(result.html).toContain('<header>SAP</header>');
    expect(result.html).toContain('<footer>© SAP</footer>');
    // No optional sections
    expect(result.html).not.toContain('data-kg-section="learning-journeys"');
    expect(result.html).not.toContain('Prerequisites');
    expect(result.html).not.toContain('Tutorials that teach this');
    expect(result.html).toContain('data-render-source="cap"');
    expect(result.gzipped).toBeInstanceOf(Buffer);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders teaches (tutorial) cards with meta', () => {
    const concept = {
      slug: 'cap', name: 'CAP', description: 'x',
      ...EMPTY_REL,
      teaches: [{ slug: 'cap-start', title: 'Get started with CAP', experienceTag: 'Beginner', stepCount: 5 }],
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4, SHELL);
    expect(result.html).toContain('Tutorials that teach this');
    expect(result.html).toContain('href="/tutorials/cap-start/"');
    expect(result.html).toContain('Get started with CAP');
    expect(result.html).toContain('Beginner');
    expect(result.html).toContain('5 steps');
  });

  it('renders learning journeys and blog posts when populated', () => {
    const concept = { slug: 'cap', name: 'CAP', description: 'x', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      learningJourneys: [{ slug: 'lj1', title: 'Get started', url: 'https://learning.sap.com/lj/1', level: 'Beginner', durationHours: 2 }],
      blogPosts: [{ slug: 'bp1', title: 'CAP intro', url: 'https://blogs.sap.com/1', authorName: 'Alice' }],
    };
    const result = renderConceptDetail(concept, phase4, SHELL);
    expect(result.html).toContain('data-kg-section="learning-journeys"');
    expect(result.html).toContain('Get started');
    expect(result.html).toContain('Beginner');
    expect(result.html).toContain('2h');
    expect(result.html).toContain('data-kg-section="blog-posts"');
    expect(result.html).toContain('CAP intro');
    expect(result.html).toContain('by Alice');
  });

  it('emits the no-link card variant for an unsafe (non-http) url', () => {
    const concept = { slug: 'cap', name: 'CAP', description: 'x', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      videos: [{ slug: 'v1', title: 'Dodgy', url: 'javascript:alert(1)', channelTitle: 'X' }],
    };
    const result = renderConceptDetail(concept, phase4, SHELL);
    expect(result.html).toContain('data-kg-section="videos"');
    expect(result.html).toContain('Dodgy');
    // no anchor for the unsafe URL
    expect(result.html).not.toContain('javascript:alert(1)');
    expect(result.html).not.toContain('href="javascript');
  });

  it('escapes HTML in name, description, and card titles', () => {
    const concept = {
      slug: 'x', name: '<script>alert(1)</script>', description: 'A & B',
      ...EMPTY_REL,
      teaches: [{ slug: 't1', title: '<img src=x onerror=1>' }],
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4, SHELL);
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<script>alert(1)</script>');
    expect(result.html).toContain('A &amp; B');
    expect(result.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(result.html).not.toContain('<img src=x onerror=1>');
  });

  it('escapes an unsafe external card title (no-link variant)', () => {
    const concept = { slug: 'x', name: 'X', description: '', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      samples: [{ slug: 's1', title: '<b>x</b>', url: 'ftp://nope', language: 'JS' }],
    };
    const result = renderConceptDetail(concept, phase4, SHELL);
    expect(result.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(result.html).not.toContain('<b>x</b>');
  });

  it('throws when shell fragments are missing', () => {
    const concept = { slug: 'x', name: 'X', description: '', ...EMPTY_REL };
    expect(() => renderConceptDetail(concept, EMPTY_PHASE4, {})).toThrow(/shell fragments missing/);
  });

  it('throws when concept.slug or name is missing', () => {
    expect(() => renderConceptDetail({}, EMPTY_PHASE4, SHELL)).toThrow(/concept\.slug and concept\.name/);
  });

  it('tolerates missing phase4 / relationship arrays (defaults to empty)', () => {
    const concept = { slug: 'x', name: 'X', description: 'y' };
    const result = renderConceptDetail(concept, {}, SHELL);
    expect(result.html).toContain('<h1 class="concept-page__title">X</h1>');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHash is stable for the same input and gzipped round-trips', async () => {
    const { gunzipSync } = await import('node:zlib');
    const concept = { slug: 'x', name: 'X', description: 'y', ...EMPTY_REL };
    const a = renderConceptDetail(concept, EMPTY_PHASE4, SHELL);
    const b = renderConceptDetail(concept, EMPTY_PHASE4, SHELL);
    expect(a.contentHash).toBe(b.contentHash);
    expect(gunzipSync(a.gzipped).toString('utf-8')).toBe(a.html);
  });
});
