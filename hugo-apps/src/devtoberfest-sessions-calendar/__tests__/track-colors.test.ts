import { describe, it, expect } from 'vitest';
import { buildTrackColorMap, legendFor } from '../track-colors';

describe('track-colors', () => {
  it('assigns a stable colour per track regardless of input order/dupes', () => {
    const a = buildTrackColorMap(['CAP', 'ABAP', 'AI', 'ABAP']);
    const b = buildTrackColorMap(['AI', 'ABAP', 'CAP']);
    expect(a.get('ABAP')).toEqual(b.get('ABAP'));
    expect(a.get('CAP')).toEqual(b.get('CAP'));
    // sorted-alphabetical assignment: ABAP gets palette[0]
    expect([...a.keys()]).toEqual(['ABAP', 'AI', 'CAP']);
  });

  it('every colour has bg/border/text strings', () => {
    const m = buildTrackColorMap(['X']);
    const c = m.get('X')!;
    expect(typeof c.bg).toBe('string');
    expect(typeof c.border).toBe('string');
    expect(typeof c.text).toBe('string');
  });

  it('overflow past palette length wraps without throwing', () => {
    const many = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, '0')}`);
    const m = buildTrackColorMap(many);
    expect(m.size).toBe(20);
    for (const name of many) expect(m.get(name)).toBeTruthy();
  });

  it('legendFor lists tracks in alphabetical order', () => {
    const m = buildTrackColorMap(['CAP', 'ABAP']);
    expect(legendFor(m).map((e) => e.trackName)).toEqual(['ABAP', 'CAP']);
  });
});
