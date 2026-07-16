import { describe, it, expect, beforeEach, vi } from 'vitest';

let row = null;
const fakeDb = { run: vi.fn(async () => (row ? [row] : [])) };
vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({ ChatSettings: 'ChatSettings' }),
    connect: { to: vi.fn(async () => fakeDb) },
    log: () => ({ warn(){}, error(){}, info(){}, debug(){} }),
  },
}));
// SELECT.one.from(ChatSettings) → resolve `row`
globalThis.SELECT = { one: { from: () => Promise.resolve(row) } };

import { resolveA2aSettings, _resetA2aSettingsCache } from '../../../srv/lib/runtime-config/a2a-settings.js';

describe('resolveA2aSettings', () => {
  beforeEach(() => { row = null; _resetA2aSettingsCache(); vi.clearAllMocks(); });

  it('returns defaults when no row (enabled true, empty urls)', async () => {
    const s = await resolveA2aSettings();
    expect(s).toEqual({ enabled: true, publicBaseUrl: '', tokenUrl: '' });
  });

  it('reads DB values when present', async () => {
    row = { a2aEnabled: false, a2aPublicBaseUrl: 'https://x.example', a2aTokenUrl: 'https://uaa/token' };
    const s = await resolveA2aSettings();
    expect(s).toEqual({ enabled: false, publicBaseUrl: 'https://x.example', tokenUrl: 'https://uaa/token' });
  });

  it('treats null a2aEnabled as default true', async () => {
    row = { a2aEnabled: null, a2aPublicBaseUrl: null, a2aTokenUrl: null };
    const s = await resolveA2aSettings();
    expect(s.enabled).toBe(true);
    expect(s.publicBaseUrl).toBe('');
    expect(s.tokenUrl).toBe('');
  });

  it('caches within TTL (second call does not re-query)', async () => {
    row = { a2aEnabled: true };
    await resolveA2aSettings();
    const from = SELECT.one.from;
    let calls = 0;
    SELECT.one.from = () => { calls++; return Promise.resolve(row); };
    try {
      await resolveA2aSettings();
      expect(calls).toBe(0); // served from cache
    } finally {
      SELECT.one.from = from; // restore even if the assertion throws
    }
  });

  it('falls back to raw SQL (UPPERCASE keys) when the CAP path throws', async () => {
    const from = SELECT.one.from;
    SELECT.one.from = () => { throw new Error('model not loaded'); };
    row = { A2AENABLED: false, A2APUBLICBASEURL: 'https://raw.example', A2ATOKENURL: 'https://raw/token' };
    try {
      const s = await resolveA2aSettings();
      expect(fakeDb.run).toHaveBeenCalled();
      expect(s).toEqual({ enabled: false, publicBaseUrl: 'https://raw.example', tokenUrl: 'https://raw/token' });
    } finally {
      SELECT.one.from = from;
    }
  });

  it('returns defaults when both CAP and raw-SQL reads throw', async () => {
    const from = SELECT.one.from;
    SELECT.one.from = () => { throw new Error('model not loaded'); };
    fakeDb.run.mockRejectedValueOnce(new Error('db down'));
    try {
      const s = await resolveA2aSettings();
      expect(s).toEqual({ enabled: true, publicBaseUrl: '', tokenUrl: '' });
    } finally {
      SELECT.one.from = from;
    }
  });
});
