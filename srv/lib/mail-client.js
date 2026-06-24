import cds from '@sap/cds';
import { createTransport } from 'nodemailer';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveSecret } from './secret-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'templates', 'notification');
const TEMPLATE_NAMES = ['first', 'second', 'third', 'final'];

const SMTP_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FROM = 'developers@sap.com';

// State on globalThis so the module-singleton-multiplicity issue on Vitest+CDS
// (Windows) doesn't yield divergent caches. Same pattern as credstore.js +
// secret-resolver.js. See feedback_module_singletons_in_vitest_cds memory entry.
const STATE_KEY = Symbol.for('com.sap.developers.ims:mail-client');
const _state = (globalThis[STATE_KEY] ??= {
  transporter: null,
  resolvedAt: 0,
});

/**
 * Resolve the SMTP password via the shared secret-resolver (credstore-first,
 * env fallback, 5-min TTL cache, warn-once-per-window logging).
 */
async function resolveSmtpPassword() {
  return resolveSecret('SMTP_PASS', { ttlMs: SMTP_TTL_MS, logTag: '[mail]' });
}

async function getTransporter() {
  if (_state.transporter && Date.now() - _state.resolvedAt < SMTP_TTL_MS) {
    return _state.transporter;
  }

  const host = process.env.SMTP_HOST;
  if (host) {
    const password = await resolveSmtpPassword();
    if (!password) return null;
    _state.transporter = createTransport({
      host,
      // Default port shifts from 1025 (MailHog dev default) to 587 (SMTP
      // submission). Local dev still works by setting SMTP_PORT=1025 explicitly.
      // Spec edge case #8 covers the MailHog flow.
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: password },
    });
    _state.resolvedAt = Date.now();
    return _state.transporter;
  }

  // Legacy fallback: managed mail-service binding tagged 'mail'. No project
  // today binds one — kept as an escape hatch if SAP Cloud Mail Service or a
  // similar managed offering ever appears in the subaccount entitlements.
  try {
    const xsenv = await import('@sap/xsenv');
    xsenv.default.loadEnv();
    const creds = xsenv.default.serviceCredentials({ tag: 'mail' });
    _state.transporter = createTransport({
      host: creds.mail_host,
      port: creds.mail_port,
      secure: creds.mail_port === 465,
      auth: { user: creds.mail_user, pass: creds.mail_password },
    });
    _state.resolvedAt = Date.now();
    return _state.transporter;
  } catch {
    return null;
  }
}

export function loadTemplate(level) {
  const name = TEMPLATE_NAMES[level];
  if (!name) throw new Error(`Invalid notification level: ${level}`);
  return readFileSync(join(TEMPLATE_DIR, `${name}.html`), 'utf-8');
}

export function resolveTemplate(html, variables) {
  return html.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] || '');
}

export async function sendNotificationEmail({ to, cc, subject, level, variables }) {
  const LOG = cds.log('mail');
  const html = resolveTemplate(loadTemplate(level), variables);

  const mailOptions = {
    from: process.env.SMTP_FROM || DEFAULT_FROM,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: cc?.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    subject,
    html
  };

  try {
    const transport = await getTransporter();
    if (!transport) {
      LOG.warn('No mail transport configured — email queued for retry');
      const { FailedEmails } = cds.entities('com.sap.developers.ims');
      await INSERT.into(FailedEmails).entries({
        to: mailOptions.to, cc: mailOptions.cc || '',
        subject, body: html, errorMessage: 'No mail transport configured',
        createdAt: new Date().toISOString(), retryCount: 0, status: 'PENDING'
      });
      return { success: false, error: 'No mail transport configured' };
    }
    await transport.sendMail(mailOptions);
    LOG.info(`Email sent to ${mailOptions.to} — subject: ${subject}`);
    return { success: true };
  } catch (err) {
    LOG.error('Email send failed, storing for retry:', err.message);
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    await INSERT.into(FailedEmails).entries({
      to: mailOptions.to,
      cc: mailOptions.cc || '',
      subject,
      body: html,
      errorMessage: err.message,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'PENDING'
    });
    return { success: false, error: err.message };
  }
}

export async function retryFailedEmails() {
  const LOG = cds.log('mail');
  const { FailedEmails } = cds.entities('com.sap.developers.ims');
  const pending = await SELECT.from(FailedEmails).where({ status: 'PENDING' });

  let retried = 0;
  for (const msg of pending) {
    if (msg.retryCount >= msg.maxRetries) {
      await UPDATE(FailedEmails, msg.ID).set({ status: 'FAILED_PERMANENTLY' });
      continue;
    }
    try {
      const transport = await getTransporter();
      await transport.sendMail({
        from: process.env.SMTP_FROM || DEFAULT_FROM,
        to: msg.to,
        cc: msg.cc || undefined,
        subject: msg.subject,
        html: msg.body
      });
      await DELETE.from(FailedEmails, msg.ID);
      retried++;
    } catch (err) {
      const newCount = msg.retryCount + 1;
      const update = { retryCount: newCount };
      if (newCount >= msg.maxRetries) update.status = 'FAILED_PERMANENTLY';
      await UPDATE(FailedEmails, msg.ID).set(update);
      LOG.warn(`Email retry failed (${newCount}/${msg.maxRetries}):`, err.message);
    }
  }
  LOG.info(`Retried ${retried}/${pending.length} failed emails`);
  return retried;
}

/** Test-only: clear cached transporter so unit tests can swap credstore mocks. */
export function _resetForTests() {
  _state.transporter = null;
  _state.resolvedAt = 0;
}

/** Test-only: expose getTransporter so unit tests can assert on the resolved transport. */
export async function _getTransporterForTests() {
  return getTransporter();
}
