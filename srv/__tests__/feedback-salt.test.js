// srv/__tests__/feedback-salt.test.js
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => { process.env.SUBMISSION_SALT_SECRET = 'test-secret-do-not-use'; });

describe('feedback-salt', () => {
  it('hashIp is deterministic within a UTC day', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(hashIp('1.2.3.4', day)).toBe(hashIp('1.2.3.4', day));
  });

  it('hashIp differs across days', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const a = hashIp('1.2.3.4', new Date('2026-05-20T12:00:00Z'));
    const b = hashIp('1.2.3.4', new Date('2026-05-21T12:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('hashIp returns 64-char hex', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    expect(hashIp('1.2.3.4')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different IPs hash to different values on the same day', async () => {
    const { hashIp } = await import('../lib/feedback-salt.js');
    const day = new Date('2026-05-20T12:00:00Z');
    expect(hashIp('1.2.3.4', day)).not.toBe(hashIp('5.6.7.8', day));
  });
});
