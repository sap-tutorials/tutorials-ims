/**
 * Hybrid test (#545): credstore write/read/delete round-trip for SMTP_PASS.
 *
 * Runs against real BTP credstore via `cds bind --exec`. Skipped without
 * the binding. Pure infrastructure verification — does NOT send mail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let credstore;
const TEST_ALIAS = 'SMTP_PASS_HYBRID_TEST';
const TEST_VALUE = `hybrid-test-${process.pid}`;

beforeAll(async () => {
  credstore = await import('../../srv/lib/credstore.js');
});

afterAll(async () => {
  // Idempotent: delete returns true even if the alias is already gone.
  try { await credstore.deleteSecret(TEST_ALIAS); } catch { /* best-effort */ }
});

describe('credstore — SMTP password round-trip', () => {
  it('write → read returns the same plaintext', async () => {
    await credstore.writeSecret(TEST_ALIAS, TEST_VALUE);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBe(TEST_VALUE);
  });

  it('delete is idempotent', async () => {
    const result1 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result1).toBe(true);
    const result2 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result2).toBe(true);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBeNull();
  });
});
