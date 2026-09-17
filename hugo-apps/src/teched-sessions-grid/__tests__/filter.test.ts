import { describe, it, expect } from 'vitest';
import { filterSessions, type TechEdSession } from '../filter';

const data: TechEdSession[] = [
  {
    slug: 'ai-001', title: 'Build with SAP AI Core', abstract: 'Generative AI on BTP.',
    venue: 'BERLIN', track: 'ai', trackName: 'AI & Machine Learning', sessionCode: 'AI001',
    speakers: ['ada-lovelace'], speakerNames: ['Ada Lovelace'],
    room: 'Hall A',
  },
  {
    slug: 'cap-002', title: 'CAP deep dive', abstract: 'Node.js services with CDS.',
    venue: 'VIRTUAL', track: 'cap', trackName: 'Application Development', sessionCode: 'CAP002',
    speakers: ['grace-hopper'], speakerNames: ['Grace Hopper'],
    room: 'Community Theater',
  },
  {
    slug: 'ai-003', title: 'RAG patterns', abstract: 'Vector search and embeddings.',
    venue: 'VIRTUAL', track: 'ai', trackName: 'AI & Machine Learning', sessionCode: 'AI003',
    speakers: ['ada-lovelace', 'grace-hopper'], speakerNames: ['Ada Lovelace', 'Grace Hopper'],
    room: '  community theater  ', // case/trim variant
  },
];

describe('filterSessions', () => {
  it('returns all sessions for an empty state', () => {
    expect(filterSessions(data)).toHaveLength(3);
    expect(filterSessions(data, {})).toHaveLength(3);
  });

  it('filters by venue', () => {
    expect(filterSessions(data, { venue: 'BERLIN' }).map((s) => s.slug)).toEqual(['ai-001']);
    expect(filterSessions(data, { venue: 'VIRTUAL' }).map((s) => s.slug)).toEqual(['cap-002', 'ai-003']);
  });

  it('filters by track slug', () => {
    expect(filterSessions(data, { track: 'ai' }).map((s) => s.slug)).toEqual(['ai-001', 'ai-003']);
    expect(filterSessions(data, { track: 'cap' }).map((s) => s.slug)).toEqual(['cap-002']);
  });

  it('filters by speaker slug (membership test)', () => {
    expect(filterSessions(data, { speaker: 'grace-hopper' }).map((s) => s.slug)).toEqual(['cap-002', 'ai-003']);
    expect(filterSessions(data, { speaker: 'ada-lovelace' }).map((s) => s.slug)).toEqual(['ai-001', 'ai-003']);
    expect(filterSessions(data, { speaker: 'nobody' })).toHaveLength(0);
  });

  it('query matches title, abstract, speaker name and track name', () => {
    expect(filterSessions(data, { query: 'deep dive' }).map((s) => s.slug)).toEqual(['cap-002']); // title
    expect(filterSessions(data, { query: 'embeddings' }).map((s) => s.slug)).toEqual(['ai-003']); // abstract
    expect(filterSessions(data, { query: 'grace' }).map((s) => s.slug)).toEqual(['cap-002', 'ai-003']); // speaker name
    expect(filterSessions(data, { query: 'machine learning' }).map((s) => s.slug)).toEqual(['ai-001', 'ai-003']); // track name
  });

  it('query is case-insensitive and trimmed', () => {
    expect(filterSessions(data, { query: '  RAG  ' }).map((s) => s.slug)).toEqual(['ai-003']);
  });

  it('falls back to speaker slugs when speakerNames are absent', () => {
    const raw: TechEdSession[] = [{ slug: 'x', title: 'T', venue: 'BERLIN', speakers: ['jane-doe'] }];
    expect(filterSessions(raw, { query: 'jane-doe' })).toHaveLength(1);
  });

  it('ANDs facets together — only sessions matching ALL survive', () => {
    // ai track + VIRTUAL venue → only ai-003
    expect(filterSessions(data, { track: 'ai', venue: 'VIRTUAL' }).map((s) => s.slug)).toEqual(['ai-003']);
    // ai track + grace speaker → only ai-003 (ai-001 has no grace)
    expect(filterSessions(data, { track: 'ai', speaker: 'grace-hopper' }).map((s) => s.slug)).toEqual(['ai-003']);
    // BERLIN + query 'embeddings' → none (embeddings is only on a VIRTUAL session)
    expect(filterSessions(data, { venue: 'BERLIN', query: 'embeddings' })).toHaveLength(0);
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(data));
    filterSessions(data, { venue: 'BERLIN', query: 'ai' });
    expect(data).toEqual(copy);
  });

  // --- Clubhouse facet (issue #2392 item 5) -----------------------------------

  it('clubhouse=true keeps only sessions whose room is "Community Theater" (case-insensitive, trimmed)', () => {
    const result = filterSessions(data, { clubhouse: true });
    // cap-002 has room "Community Theater"; ai-003 has "  community theater  " (trim/case variant)
    // ai-001 has room "Hall A" — excluded
    expect(result.map((s) => s.slug)).toEqual(['cap-002', 'ai-003']);
  });

  it('clubhouse=false leaves the full set unchanged', () => {
    expect(filterSessions(data, { clubhouse: false })).toHaveLength(3);
  });

  it('absent clubhouse facet leaves the full set unchanged', () => {
    expect(filterSessions(data, {})).toHaveLength(3);
    expect(filterSessions(data)).toHaveLength(3);
  });

  it('clubhouse excludes sessions with no room or null room', () => {
    const raw: TechEdSession[] = [
      { slug: 'a', title: 'No room', room: null },
      { slug: 'b', title: 'Empty room', room: '' },
      { slug: 'c', title: 'Theater', room: 'Community Theater' },
    ];
    expect(filterSessions(raw, { clubhouse: true }).map((s) => s.slug)).toEqual(['c']);
  });

  it('clubhouse ANDs with track — only Community Theater sessions in the given track survive', () => {
    // cap-002 is track 'cap' + Community Theater; ai-003 is track 'ai' + Community Theater
    expect(filterSessions(data, { clubhouse: true, track: 'cap' }).map((s) => s.slug)).toEqual(['cap-002']);
    expect(filterSessions(data, { clubhouse: true, track: 'ai' }).map((s) => s.slug)).toEqual(['ai-003']);
  });

  it('clubhouse ANDs with venue — only matching venue + Community Theater sessions survive', () => {
    // cap-002 is VIRTUAL + Community Theater; ai-003 is VIRTUAL + Community Theater; ai-001 is BERLIN non-Theater
    expect(filterSessions(data, { clubhouse: true, venue: 'VIRTUAL' }).map((s) => s.slug)).toEqual(['cap-002', 'ai-003']);
    expect(filterSessions(data, { clubhouse: true, venue: 'BERLIN' })).toHaveLength(0);
  });
});
