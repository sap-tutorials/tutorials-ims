// Unit test for the e2e tier's config module (#1338). Lives under test/unit/
// (not test/e2e/) so it runs in the fast `unit` project — the `e2e` project is
// excluded from the unit glob and only runs against a deployed approuter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEYS = [
  'PLAYWRIGHT_BASE_URL',
  'SMOKE_BASE_URL',
  'SMOKE_SRV_URL',
  'SMOKE_TECH_USER',
  'SMOKE_TECH_PASSWORD',
];

// The config reads env vars at module-evaluation time (top-level exports), so
// each case resets the module registry and re-imports to pick up fresh env.
// A static specifier is required — Vite rejects a fully-dynamic import path.
function loadConfig() {
  vi.resetModules();
  return import('../e2e/e2e.config.js');
}

describe('e2e.config', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('authHeader returns undefined and hasCredentials false when creds missing', async () => {
    const mod = await loadConfig();
    expect(mod.authHeader()).toBeUndefined();
    expect(mod.hasCredentials()).toBe(false);
  });

  it('authHeader returns a Basic token when both creds are set', async () => {
    process.env.SMOKE_TECH_USER = 'alice';
    process.env.SMOKE_TECH_PASSWORD = 'secret';
    const mod = await loadConfig();
    expect(mod.authHeader()).toBe('Basic ' + Buffer.from('alice:secret').toString('base64'));
    expect(mod.hasCredentials()).toBe(true);
  });

  it('hasBaseUrl is false with no URL env, true when PLAYWRIGHT_BASE_URL set', async () => {
    let mod = await loadConfig();
    expect(mod.hasBaseUrl()).toBe(false);
    process.env.PLAYWRIGHT_BASE_URL = 'https://example.com';
    mod = await loadConfig();
    expect(mod.hasBaseUrl()).toBe(true);
  });

  it('BASE_URL prefers PLAYWRIGHT_BASE_URL over SMOKE_BASE_URL and strips trailing slash', async () => {
    process.env.PLAYWRIGHT_BASE_URL = 'https://pw.example.com/';
    process.env.SMOKE_BASE_URL = 'https://smoke.example.com';
    const mod = await loadConfig();
    expect(mod.BASE_URL).toBe('https://pw.example.com');
  });

  it('SRV_URL falls back to BASE_URL when SMOKE_SRV_URL unset', async () => {
    process.env.SMOKE_BASE_URL = 'https://approuter.example.com';
    const mod = await loadConfig();
    expect(mod.SRV_URL).toBe('https://approuter.example.com');
  });
});
