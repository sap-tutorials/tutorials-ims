/**
 * Hybrid test (#545 / post-#588): credstore write/read/delete round-trip.
 *
 * Runs against the REAL BTP credstore via `cds bind --exec` (the credstore
 * binding is declared in `.cdsrc-private.json` — see [docs/developers/operations/runtime-config.md]).
 * Skipped silently without the binding.
 *
 * This is the **canonical end-to-end credstore guard** for this project.
 * It catches platform-default flips that unit tests cannot — including the
 * 2026-06-21 DevRel-subaccount cutover, after which the credstore began
 * requiring JWE-encrypted POST bodies (payload encryption ON by default).
 * Five Secrets PRs (#546, #547, #549, #586, #588) shipped without this
 * test running against the new subaccount; this run-against-live-binding
 * harness is the back-stop that makes the 6th not happen.
 *
 * Originally written for SMTP_PASS (alias is arbitrary); the alias is
 * still SMTP-named for backward compatibility with the test infra plumbed
 * by #545. Pure infrastructure verification — does NOT send mail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let credstore;
const TEST_ALIAS = 'SMTP_PASS_HYBRID_TEST';
const TEST_VALUE = `hybrid-test-${process.pid}-${Date.now()}`;

beforeAll(async () => {
  credstore = await import('../../srv/lib/credstore.js');
});

afterAll(async () => {
  // Idempotent: delete returns true even if the alias is already gone.
  try { await credstore.deleteSecret(TEST_ALIAS); } catch { /* best-effort */ }
});

describe('credstore — live round-trip (mTLS + payload encryption)', () => {
  it('write → read returns the same plaintext', async () => {
    await credstore.writeSecret(TEST_ALIAS, TEST_VALUE);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBe(TEST_VALUE);
  });

  it('delete is idempotent and removes the entry', async () => {
    const result1 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result1).toBe(true);
    const result2 = await credstore.deleteSecret(TEST_ALIAS);
    expect(result2).toBe(true);
    const got = await credstore.readSecret(TEST_ALIAS);
    expect(got).toBeNull();
  });

  it('rejects empty values at the client (defense in depth)', async () => {
    await expect(credstore.writeSecret(TEST_ALIAS, '')).rejects.toThrow(/empty or non-string/);
  });

  it('round-trips a multi-line value with quotes / unicode / control chars', async () => {
    // Stress the JWE payload pipeline: anything that would have broken plain
    // JSON serialization (un-escaped newlines, embedded quotes, multi-byte
    // characters, control chars) must also survive a JWE round-trip.
    const alias = `${TEST_ALIAS}_STRESS`;
    const value = 'line1 "with quotes"\nline2\té中文\u{1F600}';
    try {
      await credstore.writeSecret(alias, value);
      const got = await credstore.readSecret(alias);
      expect(got).toBe(value);
    } finally {
      try { await credstore.deleteSecret(alias); } catch { /* */ }
    }
  });

  it('write→read round-trips all 5 SMTP transport aliases (mail-client surface area)', async () => {
    // Five aliases mirroring the production set (SMTP_HOST/PORT/USER/FROM/PASS).
    // Using __TEST__ prefix + pid so these don't clash with real SMTP_* rows in
    // the credstore that production tutorials-srv reads at startup.
    //
    // Purpose: prove platform plumbing (mTLS, JWE payload encryption, namespace
    // scoping) works for ALL 5 aliases, not just the one historically-tested
    // SMTP_PASS_HYBRID_TEST alias. The lesson from the 5-PR Secrets spiral
    // (PRs #546/#547/#549/#586/#588) is that platform-default flips can affect
    // one credstore code path while leaving another working — running this
    // against the live binding is the back-stop.
    const aliases = [
      `__TEST__SMTP_HOST_${process.pid}`,
      `__TEST__SMTP_PORT_${process.pid}`,
      `__TEST__SMTP_USER_${process.pid}`,
      `__TEST__SMTP_FROM_${process.pid}`,
      `__TEST__SMTP_PASS_${process.pid}`,
    ];
    const values = [
      'hybrid.smtp.example.com',
      '2587',
      'hybrid-user',
      'hybrid-from@example.com',
      'hybrid-pass-secret',
    ];
    try {
      // Write all 5 sequentially. Parallel would shave a few hundred ms but
      // would also exercise the credstore's per-account rate-limit; serial
      // keeps this test boring and reliable.
      for (let i = 0; i < aliases.length; i++) {
        await credstore.writeSecret(aliases[i], values[i]);
      }
      // Read all 5 back; assert exact-match.
      for (let i = 0; i < aliases.length; i++) {
        const got = await credstore.readSecret(aliases[i]);
        expect(got).toBe(values[i]);
      }
    } finally {
      // Best-effort cleanup — even if an assertion above fails, we want the
      // test aliases gone so the next run isn't polluted. deleteSecret is
      // idempotent.
      for (const alias of aliases) {
        try { await credstore.deleteSecret(alias); } catch { /* swallow */ }
      }
    }
  });
});
