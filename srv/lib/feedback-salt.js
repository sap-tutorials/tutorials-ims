// srv/lib/feedback-salt.js
//
// Per-day IP hashing for the /feedback/submit rate-limit bucket. Salt comes
// from SUBMISSION_SALT_SECRET (BTP Credential Store, env fallback, 5-min TTL
// cache via the shared secret-resolver).
//
// Async by design (PR follow-up to #592). The previous sync version read
// `process.env.SUBMISSION_SALT_SECRET` directly, which meant admin-UI
// rotations only took effect after `cf set-env tutorials-srv … && cf restart`.
// Routing through `resolveSecret()` makes admin-UI saves take effect on the
// next cache miss (≤5 min) without a restart — symmetric with the
// rebuild-trigger.js and mail-client.js read paths.
//
// All call sites already live inside async handlers (developer-service.js
// `submitTutorialFeedback` action), so the .await migration is mechanical.
import crypto from 'node:crypto';
import { resolveSecret } from './secret-resolver.js';

async function getSecret() {
  const s = await resolveSecret('SUBMISSION_SALT_SECRET', { logTag: '[feedback-salt]' });
  if (!s) throw new Error('SUBMISSION_SALT_SECRET is not set');
  return s;
}

export async function dailySaltFor(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  const secret = await getSecret();
  return crypto.createHash('sha256').update(secret + ymd).digest('hex');
}

export async function hashIp(ip, date = new Date()) {
  const salt = await dailySaltFor(date);
  return crypto.createHash('sha256').update(ip + salt).digest('hex');
}
