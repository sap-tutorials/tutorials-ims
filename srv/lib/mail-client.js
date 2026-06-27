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
  fromAddress: null,
});

const SMTP_ALIASES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM', 'SMTP_PASS'];

/**
 * Resolve all 5 SMTP transport fields via the shared secret-resolver (credstore-first,
 * env fallback, 5-min TTL cache, warn-once-per-window logging). Returns `null` for any
 * field the resolver couldn't find.
 *
 * Resolved sequentially (not Promise.all): the resolver's dynamic `import('./credstore.js')`
 * races with vi.mock's module-resolution under concurrent calls, so unit tests would
 * see only the first parallel alias hit the mocked credstore. Serial calls cost a
 * fraction of a millisecond once the cache is warm, and the behavior is identical in
 * production.
 */
async function resolveSmtpConfig() {
  const cfg = {};
  for (const alias of SMTP_ALIASES) {
    cfg[alias] = await resolveSecret(alias, { ttlMs: SMTP_TTL_MS, logTag: '[mail]' });
  }
  return cfg;
}

async function getTransporter() {
  if (_state.transporter && Date.now() - _state.resolvedAt < SMTP_TTL_MS) {
    return _state.transporter;
  }

  const cfg = await resolveSmtpConfig();
  if (cfg.SMTP_HOST) {
    if (!cfg.SMTP_PASS) return null;
    // Default port shifts from 1025 (MailHog dev default) to 587 (SMTP submission).
    // Local dev still works by setting SMTP_PORT=1025 explicitly (env var or
    // credstore row). Spec edge case #8 covers the MailHog flow.
    const port = Number(cfg.SMTP_PORT) || 587;
    _state.transporter = createTransport({
      host: cfg.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    });
    _state.fromAddress = cfg.SMTP_FROM || DEFAULT_FROM;
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
    _state.fromAddress = DEFAULT_FROM;
    _state.resolvedAt = Date.now();
    return _state.transporter;
  } catch {
    return null;
  }
}

export function loadTemplate(levelOrName) {
  let name;
  if (typeof levelOrName === 'number') {
    name = TEMPLATE_NAMES[levelOrName];
    if (!name) throw new Error(`Invalid notification level: ${levelOrName}`);
  } else if (typeof levelOrName === 'string') {
    if (levelOrName.includes('/') || levelOrName.includes('\\') || levelOrName.includes('..')) {
      throw new Error(`Invalid template name: ${levelOrName}`);
    }
    name = levelOrName;
  } else {
    throw new Error(`loadTemplate requires a number or string, got ${typeof levelOrName}`);
  }
  return readFileSync(join(TEMPLATE_DIR, `${name}.html`), 'utf-8');
}

export function resolveTemplate(html, variables) {
  return html.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] || '');
}

export async function sendNotificationEmail({ to, cc, subject, level, variables, template }) {
  const LOG = cds.log('mail');
  // template takes precedence over level when provided.
  // Legacy callers passing only level get byte-identical behavior.
  const templateKey = template ?? level;
  const html = resolveTemplate(loadTemplate(templateKey), variables);

  // Build mailOptions inside the try so a throw from getTransporter() (e.g.
  // OOM during transporter construction, unexpected xsenv crash) still funnels
  // through the FailedEmails-queue path the rest of this function provides.
  // _state.fromAddress is populated by getTransporter() in both the credstore
  // path and the legacy mail-binding fallback path; null falls back to
  // DEFAULT_FROM to match pre-refactor behavior.
  let transport;
  let mailOptions;
  try {
    transport = await getTransporter();
    mailOptions = {
      from: _state.fromAddress || DEFAULT_FROM,
      to: Array.isArray(to) ? to.join(', ') : to,
      cc: cc?.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
      subject,
      html
    };
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
    // mailOptions may be undefined if the throw came from getTransporter()
    // before we built it. Fall back to the inputs in that case.
    const queueTo = mailOptions?.to ?? (Array.isArray(to) ? to.join(', ') : to);
    const queueCc = mailOptions?.cc ?? (cc?.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : '');
    await INSERT.into(FailedEmails).entries({
      to: queueTo,
      cc: queueCc || '',
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
        from: _state.fromAddress || DEFAULT_FROM,
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
  _state.fromAddress = null;
}

/** Test-only: expose getTransporter so unit tests can assert on the resolved transport. */
export async function _getTransporterForTests() {
  return getTransporter();
}
