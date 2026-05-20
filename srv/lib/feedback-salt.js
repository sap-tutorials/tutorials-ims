// srv/lib/feedback-salt.js
import crypto from 'node:crypto';

function getSecret() {
  const s = process.env.SUBMISSION_SALT_SECRET;
  if (!s) throw new Error('SUBMISSION_SALT_SECRET is not set');
  return s;
}

export function dailySaltFor(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(getSecret() + ymd).digest('hex');
}

export function hashIp(ip, date = new Date()) {
  return crypto.createHash('sha256').update(ip + dailySaltFor(date)).digest('hex');
}
