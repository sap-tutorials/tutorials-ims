import { describe, it, expect } from 'vitest';
import { renderConceptDetail } from '../../srv/lib/concept-detail-render.js';

// Task 1 of docs/superpowers/plans/2026-07-08-concepts-scale.md (#1327),
// reconciled to Option A (#1327 Task 3): renderConceptDetail now emits the
// BODY fragment (<article class="concept-page">…</article>) only — the publish
// path composes it into the __shell__ chrome via composeShell, the same way
// group/mission catalog pages are rendered. No <html>/<head>/shell scaffold.
//
// Signature: renderConceptDetail(concept, phase4) -> { body, contentHash }.
// Markup mirrors hugo/layouts/concepts/single.html (concept-page__*,
// concept-card-grid, data-kg-section).

const EMPTY_PHASE4 = {
  learningJourneys: [], blogPosts: [], discoveryMissions: [],
  videos: [], apiDocs: [], samples: [], helpDocs: [], communityEvents: [],
};

const EMPTY_REL = { teaches: [], requires: [], requiredBy: [], relatedTo: [] };

describe('renderConceptDetail', () => {
  it('renders a concept body with empty phase-4 arrays — omits all optional sections', () => {
    const concept = {
      slug: 'cap',
      name: 'Cloud Application Programming Model',
      description: 'SAP CAP framework.',
      ...EMPTY_REL,
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4);
    // body fragment — the article wrapped in a <main> landmark, NOT a full document
    expect(result.body.startsWith('<main>')).toBe(true);
    expect(result.body.endsWith('</main>')).toBe(true);
    expect(result.body).toContain('<article class="concept-page"');
    expect(result.body).not.toContain('<!DOCTYPE html>');
    expect(result.body).not.toContain('<head>');
    expect(result.body).toContain('<h1 class="concept-page__title">Cloud Application Programming Model</h1>');
    expect(result.body).toContain('SAP CAP framework.');
    // No optional sections
    expect(result.body).not.toContain('data-kg-section="learning-journeys"');
    expect(result.body).not.toContain('Prerequisites');
    expect(result.body).not.toContain('Tutorials that teach this');
    expect(result.body).toContain('data-render-source="cap"');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders teaches (tutorial) cards with meta', () => {
    const concept = {
      slug: 'cap', name: 'CAP', description: 'x',
      ...EMPTY_REL,
      teaches: [{ slug: 'cap-start', title: 'Get started with CAP', experienceTag: 'Beginner', stepCount: 5 }],
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4);
    expect(result.body).toContain('Tutorials that teach this');
    expect(result.body).toContain('href="/tutorials/cap-start/"');
    expect(result.body).toContain('Get started with CAP');
    expect(result.body).toContain('Beginner');
    expect(result.body).toContain('5 steps');
  });

  it('renders learning journeys and blog posts when populated', () => {
    const concept = { slug: 'cap', name: 'CAP', description: 'x', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      learningJourneys: [{ slug: 'lj1', title: 'Get started', url: 'https://learning.sap.com/lj/1', level: 'Beginner', durationHours: 2 }],
      blogPosts: [{ slug: 'bp1', title: 'CAP intro', url: 'https://blogs.sap.com/1', authorName: 'Alice' }],
    };
    const result = renderConceptDetail(concept, phase4);
    expect(result.body).toContain('data-kg-section="learning-journeys"');
    expect(result.body).toContain('Get started');
    expect(result.body).toContain('Beginner');
    expect(result.body).toContain('2h');
    expect(result.body).toContain('data-kg-section="blog-posts"');
    expect(result.body).toContain('CAP intro');
    expect(result.body).toContain('by Alice');
  });

  it('emits the no-link card variant for an unsafe (non-http) url', () => {
    const concept = { slug: 'cap', name: 'CAP', description: 'x', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      videos: [{ slug: 'v1', title: 'Dodgy', url: 'javascript:alert(1)', channelTitle: 'X' }],
    };
    const result = renderConceptDetail(concept, phase4);
    expect(result.body).toContain('data-kg-section="videos"');
    expect(result.body).toContain('Dodgy');
    // no anchor for the unsafe URL
    expect(result.body).not.toContain('javascript:alert(1)');
    expect(result.body).not.toContain('href="javascript');
  });

  it('escapes HTML in name, description, and card titles', () => {
    const concept = {
      slug: 'x', name: '<script>alert(1)</script>', description: 'A & B',
      ...EMPTY_REL,
      teaches: [{ slug: 't1', title: '<img src=x onerror=1>' }],
    };
    const result = renderConceptDetail(concept, EMPTY_PHASE4);
    expect(result.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.body).not.toContain('<script>alert(1)</script>');
    expect(result.body).toContain('A &amp; B');
    expect(result.body).toContain('&lt;img src=x onerror=1&gt;');
    expect(result.body).not.toContain('<img src=x onerror=1>');
  });

  it('escapes an unsafe external card title (no-link variant)', () => {
    const concept = { slug: 'x', name: 'X', description: '', ...EMPTY_REL };
    const phase4 = {
      ...EMPTY_PHASE4,
      samples: [{ slug: 's1', title: '<b>x</b>', url: 'ftp://nope', language: 'JS' }],
    };
    const result = renderConceptDetail(concept, phase4);
    expect(result.body).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(result.body).not.toContain('<b>x</b>');
  });

  it('throws when concept.slug or name is missing', () => {
    expect(() => renderConceptDetail({}, EMPTY_PHASE4)).toThrow(/concept\.slug and concept\.name/);
  });

  it('tolerates missing phase4 / relationship arrays (defaults to empty)', () => {
    const concept = { slug: 'x', name: 'X', description: 'y' };
    const result = renderConceptDetail(concept, {});
    expect(result.body).toContain('<h1 class="concept-page__title">X</h1>');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHash is stable for the same input', () => {
    const concept = { slug: 'x', name: 'X', description: 'y', ...EMPTY_REL };
    const a = renderConceptDetail(concept, EMPTY_PHASE4);
    const b = renderConceptDetail(concept, EMPTY_PHASE4);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.body).toBe(b.body);
  });
});
