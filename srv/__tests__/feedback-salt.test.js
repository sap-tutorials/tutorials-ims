// srv/__tests__/feedback-salt.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _resetForTests as resetResolver, _primeForTests as primeResolver } from '../lib/secret-resolver.js';

// Tests poke the env var directly to exercise the resolver's env-fallback path,
// since the unit-test runtime has no BTP binding and credstore reads error out.
// The shared resolver swallows the credstore error and falls back to env, which
// is exactly the behavior we want to assert here.
beforeAll(() => { process.env.SUBMISSION_SALT_SECRET = 'test-secret-do-not-use'; });

beforeEach(() => {
  // Drop any cached value from a prior test so env-mutating tests start clean.
  resetResolver();
});

describe('feedback-salt', () => {
  it('hashIp is deterministic within a UTC day', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(await hashIp('1.2.3.4', day)).toBe(await hashIp('1.2.3.4', day));
  });

  it('hashIp differs across days', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const a = await hashIp('1.2.3.4', new Date('2026-05-20T12:00:00Z'));
    const b = await hashIp('1.2.3.4', new Date('2026-05-21T12:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('hashIp returns 64-char hex', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    expect(await hashIp('1.2.3.4')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different IPs hash to different values on the same day', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(await hashIp('1.2.3.4', day)).not.toBe(await hashIp('5.6.7.8', day));
  });

  it('rejects when SUBMISSION_SALT_SECRET is unreachable from credstore and env', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const original = process.env.SUBMISSION_SALT_SECRET;
    delete process.env.SUBMISSION_SALT_SECRET;
    try {
      await expect(hashIp('1.2.3.4')).rejects.toThrow(/SUBMISSION_SALT_SECRET/);
    } finally {
      process.env.SUBMISSION_SALT_SECRET = original;
    }
  });

  it('different secrets produce different hashes for same IP/day', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const original = process.env.SUBMISSION_SALT_SECRET;
    const day = new Date('2026-05-20T12:00:00Z');
    try {
      process.env.SUBMISSION_SALT_SECRET = 'secret-a';
      const a = await hashIp('1.2.3.4', day);
      resetResolver();                   // bust the 5-min cache between secrets
      process.env.SUBMISSION_SALT_SECRET = 'secret-b';
      const b = await hashIp('1.2.3.4', day);
      expect(a).not.toBe(b);
    } finally {
      process.env.SUBMISSION_SALT_SECRET = original;
    }
  });

  it('primed cache wins over env (credstore-first behavior)', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const day = new Date('2026-05-20T12:00:00Z');
    const original = process.env.SUBMISSION_SALT_SECRET;
    try {
      process.env.SUBMISSION_SALT_SECRET = 'env-value';
      primeResolver('SUBMISSION_SALT_SECRET', 'credstore-value');
      // Hash matches what `credstore-value` would produce, not `env-value`.
      const credstoreHash = await hashIp('1.2.3.4', day);
      resetResolver();
      // Re-derive with env only (no primed cache) — must differ from the
      // credstore-primed value.
      const envHash = await hashIp('1.2.3.4', day);
      expect(credstoreHash).not.toBe(envHash);
    } finally {
      process.env.SUBMISSION_SALT_SECRET = original;
    }
  });
});
