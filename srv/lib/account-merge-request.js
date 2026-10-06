// srv/lib/account-merge-request.js
// Email-verified account-history-merge request/confirm handlers (#2641).
// Token: plaintext revealed once in the email; DB stores only SHA-256 hex.
import cds from '@sap/cds';
import crypto from 'node:crypto';
import { provisionDbUser } from './resolve-db-user.js';
import { validateEmail } from './email-validation.js';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { sendNotificationEmail } from './mail-client.js';
import { mergeAccounts } from './account-merge.js';

const TTL_MIN = 30;
const RATE_LIMIT_PER_HOUR = 5;
const FLAG = 'ACCOUNT_MERGE_ENABLED';

// Test seam: when ACCOUNT_MERGE_ENABLED is not yet in the registry (pre-Task-7),
// unit tests can force the flag on via globalThis.__accountMergeEnabledForTest.
// Only active in test environments; inert in production.
function isAccountMergeEnabled() {
  if (process.env.NODE_ENV === 'test' && globalThis.__accountMergeEnabledForTest !== undefined) {
    return Boolean(globalThis.__accountMergeEnabledForTest);
  }
  return isFlagEnabled(FLAG);
}

function newToken() {
  const token = `amt_${crypto.randomBytes(32).toString('base64url')}`;
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  if (process.env.NODE_ENV === 'test') {
    globalThis.__lastTokenForTest = token;
  }
  return { token, hashHex };
}

function clientIP(req) {
  return (req.headers?.['x-forwarded-for'] || req._?.req?.ip || '').split(',')[0].trim().slice(0, 45);
}

export async function handleRequestAccountMerge(req) {
  if (!isAccountMergeEnabled()) return req.reject(503, 'Account merge is disabled');
  const A = await provisionDbUser(req.user);
  if (!A) return req.error(401, 'unable to resolve user');

  const v = validateEmail(req.data.targetEmail);
  if (!v.ok) return req.error(400, v.code);
  const email = v.value;

  const { Users, AccountMergeRequests, SecondaryAccounts } = cds.entities('com.sap.developers.ims');

  // Rate limit: PENDING requests by A in the last hour.
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await SELECT.from(AccountMergeRequests)
    .where({ requesterUser_ID: A.ID, status: 'PENDING', createdAt: { '>': since } });
  if (recent.length >= RATE_LIMIT_PER_HOUR) return { status: 'RATE_LIMITED', expiresInMinutes: TTL_MIN };

  const B = await SELECT.one.from(Users).where({ email });
  if (B && B.ID === A.ID) return { status: 'BLOCKED_SELF', expiresInMinutes: TTL_MIN };

  const { token, hashHex } = newToken();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();

  // Already-merged (B is a merged secondary, or A is a secondary): record FAILED, send no email,
  // but return the generic SENT (anti-enumeration).
  let blocked = false;
  if (B) {
    const bMerged = await SELECT.one.from(SecondaryAccounts).where({ uuid: B.uuid, status: 'MERGED' });
    const aSecondary = await SELECT.one.from(SecondaryAccounts).where({ uuid: A.uuid });
    blocked = Boolean(bMerged || aSecondary);
  }

  await INSERT.into(AccountMergeRequests).entries({
    ID: crypto.randomUUID(),
    requesterUser_ID: A.ID,
    targetEmail: email,
    targetUser_ID: B?.ID ?? null,
    tokenHashHex: hashHex,
    status: (B && !blocked) ? 'PENDING' : 'FAILED',
    expiresAt,
    requesterIP: clientIP(req) || null,
  });

  if (B && !blocked) {
    const base = process.env.APPROUTER_URL || '';
    try {
      await sendNotificationEmail({
        to: email,
        subject: 'Confirm merging your SAP tutorial history',
        template: 'account-merge-verify',
        variables: {
          link: `${base}/me/merge?token=${token}`,
          initiatorEmail: A.email || '(your current account)',
          ttlMinutes: String(TTL_MIN),
        },
      });
    } catch (err) {
      // Email failure is non-fatal — the request record is already stored;
      // the user can retry. Log and continue.
      cds.log('account-merge').warn('sendNotificationEmail failed (non-fatal):', err.message);
    }
  }
  return { status: 'SENT', expiresInMinutes: TTL_MIN };
}

export async function handleConfirmAccountMerge(req) {
  if (!isAccountMergeEnabled()) return req.reject(503, 'Account merge is disabled');
  const A = await provisionDbUser(req.user);
  if (!A) return req.error(401, 'unable to resolve user');

  const token = String(req.data.token || '');
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  const { AccountMergeRequests, Users } = cds.entities('com.sap.developers.ims');

  const reqRow = await SELECT.one.from(AccountMergeRequests).where({ tokenHashHex: hashHex });
  if (!reqRow) return { status: 'INVALID', movedCounts: '{}' };
  if (reqRow.status !== 'PENDING') return { status: 'INVALID', movedCounts: '{}' };
  if (new Date(reqRow.expiresAt).getTime() < Date.now()) {
    await UPDATE(AccountMergeRequests).where({ ID: reqRow.ID }).set({ status: 'EXPIRED' });
    return { status: 'EXPIRED', movedCounts: '{}' };
  }
  if (reqRow.requesterUser_ID !== A.ID) return { status: 'WRONG_ACCOUNT', movedCounts: '{}' };

  const B = await SELECT.one.from(Users).where({ ID: reqRow.targetUser_ID });
  if (!B) return { status: 'INVALID', movedCounts: '{}' };

  try {
    // Test seam: allow unit tests to simulate a non-ALREADY_MERGED failure.
    if (process.env.NODE_ENV === 'test' && globalThis.__mergeAccountsShouldThrowForTest) {
      throw new Error('simulated merge failure');
    }
    const result = await mergeAccounts(A.uuid, B.uuid);
    await UPDATE(AccountMergeRequests).where({ ID: reqRow.ID })
      .set({ status: 'MERGED', verifiedAt: new Date().toISOString(), mergedAt: new Date().toISOString() });
    return { status: 'MERGED', movedCounts: JSON.stringify(result.movedCounts || {}) };
  } catch (e) {
    if (e.code === 'ALREADY_MERGED') return { status: 'ALREADY_MERGED', movedCounts: '{}' };
    req.error(500, 'merge failed'); // rolls back the request tx
    return { status: 'FAILED', movedCounts: '{}' };
  }
}
