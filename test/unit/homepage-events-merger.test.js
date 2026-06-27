import { describe, it, expect } from 'vitest';
import { mergeEvents } from '../../srv/lib/homepage-events-merger.js';

describe('mergeEvents', () => {
  const now = new Date('2026-07-01T00:00:00Z').getTime();

  it('dedupes by (normTitle, startsAt) — local wins, whitespace and case tolerant', () => {
    const local = [{ title: 'TechEd 2026 ', startsAt: '2026-09-15T00:00:00Z', location: 'Las Vegas', register: 'https://l/teched' }];
    const remote = [{ title: 'TechEd  2026', startsAt: '2026-09-15T00:00:00Z', location: 'Las Vegas', register: 'https://r/teched' }];
    const out = mergeEvents(local, remote, { now, limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].register).toBe('https://l/teched');  // local wins
  });

  it('drops past events', () => {
    const past   = { title: 'CodeJam Berlin', startsAt: '2026-01-05T00:00:00Z', location: 'Berlin' };
    const future = { title: 'CodeJam Tokyo',  startsAt: '2026-08-05T00:00:00Z', location: 'Tokyo'  };
    const out = mergeEvents([past, future], [], { now, limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('CodeJam Tokyo');
  });

  it('sorts ascending by startsAt and caps at limit', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      title: `E${i}`,
      startsAt: new Date(now + (10 - i) * 86_400_000).toISOString(),  // E0 is furthest in future, E9 nearest
      location: 'X'
    }));
    const out = mergeEvents(events, [], { now, limit: 3 });
    // After sort ascending, E9 (1 day out), E8 (2 days out), E7 (3 days out) win.
    expect(out.map(e => e.title)).toEqual(['E9', 'E8', 'E7']);
  });

  it('drops events with missing title or startsAt', () => {
    const events = [
      { title: 'Good', startsAt: '2026-08-01T00:00:00Z' },
      { title: '',     startsAt: '2026-08-02T00:00:00Z' },  // empty title
      { title: 'NoDate', startsAt: null },                   // null startsAt
      {                  startsAt: '2026-08-03T00:00:00Z' }  // missing title key
    ];
    const out = mergeEvents(events, [], { now, limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Good');
  });

  it('tolerates undefined inputs', () => {
    expect(mergeEvents(undefined, undefined, { now })).toEqual([]);
    expect(mergeEvents(null, null, { now })).toEqual([]);
  });

  it('defaults limit to 4 and now to Date.now()', () => {
    const far = Array.from({ length: 6 }, (_, i) => ({
      title: `F${i}`,
      startsAt: new Date(Date.now() + (i + 1) * 365 * 86_400_000).toISOString()
    }));
    const out = mergeEvents(far, []);
    expect(out).toHaveLength(4);
  });
});
