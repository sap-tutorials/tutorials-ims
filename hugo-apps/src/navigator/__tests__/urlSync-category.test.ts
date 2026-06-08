import { describe, it, expect } from 'vitest';
import { parseNavState, serializeNavState, EMPTY_STATE } from '../urlSync';

describe('urlSync — categories field', () => {
  it('parses ?category=ai,app-dev', () => {
    const s = parseNavState('https://x/?category=ai,app-dev');
    expect(s.categories).toEqual(['ai', 'app-dev']);
  });

  it('treats absent ?category= as empty array', () => {
    const s = parseNavState('https://x/');
    expect(s.categories).toEqual([]);
  });

  it('writes categories to URL with comma separator', () => {
    const next = { ...EMPTY_STATE, categories: ['ai', 'integration'] };
    const out = serializeNavState('https://x/', next);
    expect(out).toContain('category=ai%2Cintegration');
  });

  it('omits category param when categories is empty', () => {
    const out = serializeNavState('https://x/?category=ai', { ...EMPTY_STATE });
    expect(out).not.toContain('category=');
  });

  it('explicit-empty (?category=) yields empty array, URL wins', () => {
    const s = parseNavState('https://x/?category=');
    expect(s.categories).toEqual([]);
  });
});
