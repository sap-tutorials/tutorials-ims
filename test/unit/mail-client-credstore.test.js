/**
 * Unit tests for Tier-0 credstore lookup in mail-client.js (#545).
 *
 * Mirrors the pattern from test/unit/rebuild-trigger.test.js: vi.mock the
 * credstore module so we don't need a real BTP binding. The mail-client uses
 * a 5-min TTL cache for the resolved SMTP password, identical shape to
 * srv/lib/rebuild-trigger.js:60-86.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../srv/lib/credstore.js', () => ({
  readSecret: vi.fn().mockResolvedValue(null),
}));

// Mock nodemailer so we can assert on the transport config without making real network calls.
vi.mock('nodemailer', () => {
  return {
    default: { createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({ messageId: 'test' }) })) },
    createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({ messageId: 'test' }) })),
  };
});

// Avoid real DB writes from sendNotificationEmail's failure path.
vi.mock('@sap/cds', async () => {
  const actual = await vi.importActual('@sap/cds');
  return {
    default: {
      ...actual.default,
      log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      entities: () => ({
        FailedEmails: { name: 'FailedEmails' },
      }),
    },
    log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    entities: () => ({ FailedEmails: { name: 'FailedEmails' } }),
  };
});

import { _resetForTests, _getTransporterForTests } from '../../srv/lib/mail-client.js';
import { _resetForTests as _resetResolver } from '../../srv/lib/secret-resolver.js';

const ORIGINAL_ENV = { ...process.env };

describe('mail-client — Tier-0 credstore lookup', () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_PASS;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'notifier';
    process.env.SMTP_FROM = 'noreply@example.com';
    _resetForTests();
    // Reset the shared resolver too — its cache is module-singleton state
    // independent of mail-client's. Without this, a cached SMTP_PASS from a
    // previous test masks credstore-mock behavior in the next one. See
    // [feedback_module_singletons_in_vitest_cds].
    _resetResolver();
    const nodemailer = await import('nodemailer');
    nodemailer.createTransport.mockClear();
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockReset();
    credstore.readSecret.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses credstore password when credstore returns a value (credstore wins over env)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const nodemailer = await import('nodemailer');
    credstore.readSecret.mockResolvedValue('from-credstore');
    process.env.SMTP_PASS = 'from-env';

    await _getTransporterForTests();

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0]).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'notifier', pass: 'from-credstore' },
    });
  });

  it('falls through to env SMTP_PASS when credstore throws, and logs a WARN', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    const nodemailer = await import('nodemailer');
    credstore.readSecret.mockRejectedValue(new Error('credstore offline'));
    process.env.SMTP_PASS = 'from-env';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _getTransporterForTests();

    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'notifier', pass: 'from-env' },
    }));
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/credstore lookup failed/);
    warnSpy.mockRestore();
  });

  it('returns null when both credstore and env have no password', async () => {
    const nodemailer = await import('nodemailer');
    delete process.env.SMTP_PASS;
    const transport = await _getTransporterForTests();
    expect(transport).toBeNull();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('caches the resolved password for 5 minutes (second call does not re-read credstore)', async () => {
    const credstore = await import('../../srv/lib/credstore.js');
    credstore.readSecret.mockResolvedValue('cached-value');

    await _getTransporterForTests();
    await _getTransporterForTests();

    expect(credstore.readSecret).toHaveBeenCalledTimes(1);
  });
});
