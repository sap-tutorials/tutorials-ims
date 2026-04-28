import cds from '@sap/cds';
import { createTransport } from 'nodemailer';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'templates', 'notification');
const TEMPLATE_NAMES = ['first', 'second', 'third', 'final'];
const DEFAULT_FROM = 'developers@sap.com';

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    transporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 1025,
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    return transporter;
  }

  try {
    const xsenv = await import('@sap/xsenv');
    xsenv.default.loadEnv();
    const creds = xsenv.default.serviceCredentials({ tag: 'mail' });
    transporter = createTransport({
      host: creds.mail_host,
      port: creds.mail_port,
      secure: creds.mail_port === 465,
      auth: { user: creds.mail_user, pass: creds.mail_password }
    });
    return transporter;
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
    from: DEFAULT_FROM,
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
        from: DEFAULT_FROM,
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
