import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

// vi.mock is hoisted but cannot intercept modules loaded through cds.serve()'s
// loader (developer-service.js resolves its imports via CDS, not Vitest's module
// system — see admin-last-chance-action.test.js comment). The sendNotificationEmail
// mock is declared here for the schema-test pass and for completeness; the actual
// email verification in the handler tests uses the FailedEmails queue observation
// pattern or the globalThis test seam.
//
// For isFlagEnabled: account-merge-request.js reads globalThis.__accountMergeEnabledForTest
// when NODE_ENV === 'test' (pre-Task-7 seam: flag not yet in main registry).

// Boot CAP with in-memory SQLite. Module-level: must execute before describe
// blocks so schema is deployed before cds.entities() is called.
cds.test('serve', '--project', '.', '--in-memory');

// ─── Flag helpers ─────────────────────────────────────────────────────────────
function enableAccountMergeFlag() {
  globalThis.__accountMergeEnabledForTest = true;
}
function disableAccountMergeFlag() {
  globalThis.__accountMergeEnabledForTest = false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ALICE_EMAIL = 'alice@x.example';
const BOB_EMAIL   = 'bob@x.example';
const ROLES       = { 'authenticated-user': true };

// Deterministic (iss,sub) pairs — Tier 1 resolution via UserIdentities.
// Using a fake issuer so these never collide with real tokens in any env.
const ALICE_ISS = 'https://test-fake.ondemand.example';
const ALICE_SUB = 'alice-sub-uuid-test-001';
const BOB_ISS   = 'https://test-fake.ondemand.example';
const BOB_SUB   = 'bob-sub-uuid-test-001';

/**
 * Call an unbound DeveloperService action as the given user.
 * The user object shape MUST include authInfo.token.payload.(iss+sub) so that
 * provisionDbUser can resolve via Tier 1 (UserIdentities), returning the
 * deterministic seeded row rather than minting a new one on every call.
 */
function makeUser(email, iss, sub) {
  return {
    id: email,
    roles: ROLES,
    authInfo: { token: { payload: { iss, sub } } },
  };
}

const ALICE_USER = makeUser(ALICE_EMAIL, ALICE_ISS, ALICE_SUB);
const BOB_USER   = makeUser(BOB_EMAIL,   BOB_ISS,   BOB_SUB);

async function callAction(srv, event, data, user = ALICE_USER) {
  return srv.tx(
    { user: { id: user.id, roles: ROLES, authInfo: user.authInfo } },
    (tx) => tx.send({ event, data })
  );
}

// ─── Schema sanity (Task 3) ───────────────────────────────────────────────────

describe('AccountMergeRequests schema', () => {
  it('entity exists with expected elements', async () => {
    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    expect(AccountMergeRequests).toBeTruthy();
    expect(AccountMergeRequests.elements.tokenHashHex).toBeTruthy();
    expect(AccountMergeRequests.elements.requesterUser).toBeTruthy();
  });
});

// ─── requestAccountMerge handler (Task 4) ────────────────────────────────────

describe('requestAccountMerge', () => {
  let srv;
  let aliceId; // DB UUID of seeded alice — captured after seed for assertions

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');
    const { Users, UserIdentities } = cds.entities('com.sap.developers.ims');

    // Seed alice (caller A) — idempotent.
    let aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    if (!aliceRow) {
      const id = cds.utils.uuid();
      await INSERT.into(Users).entries({
        ID: id,
        sapId: null,          // not a canonical SAP ID; provisionDbUser resolves via Tier 1
        uuid: cds.utils.uuid(),
        email: ALICE_EMAIL,
        displayName: 'Alice',
      });
      aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    }
    aliceId = aliceRow.ID;

    // Seed alice's UserIdentities link so provisionDbUser resolves via Tier 1.
    const aliceLink = await SELECT.one.from(UserIdentities)
      .where({ issuer: ALICE_ISS, subject: ALICE_SUB });
    if (!aliceLink) {
      await INSERT.into(UserIdentities).entries({
        ID: cds.utils.uuid(),
        user_ID: aliceId,
        issuer: ALICE_ISS,
        subject: ALICE_SUB,
        provider: 'ias',
        emailVerified: true,
        linkedAt: new Date().toISOString(),
      });
    }

    // Seed bob (target B) — idempotent.
    let bobRow = await SELECT.one.from(Users).where({ email: BOB_EMAIL });
    if (!bobRow) {
      await INSERT.into(Users).entries({
        ID: cds.utils.uuid(),
        sapId: null,
        uuid: cds.utils.uuid(),
        email: BOB_EMAIL,
        displayName: 'Bob',
      });
      bobRow = await SELECT.one.from(Users).where({ email: BOB_EMAIL });
    }

    // Bob doesn't need a UserIdentities link — he's only used as a target (B),
    // not as a caller. The handler looks him up by email, not by provisionDbUser.
  });

  afterEach(() => {
    disableAccountMergeFlag();
    vi.clearAllMocks();
  });

  it('503 when flag OFF', async () => {
    // Flag is off by default (disableAccountMergeFlag in afterEach + initial undefined/false).
    await expect(
      callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL })
    ).rejects.toBeTruthy();
  });

  it('BLOCKED_SELF when target email resolves to the caller', async () => {
    enableAccountMergeFlag();
    const r = await callAction(srv, 'requestAccountMerge', { targetEmail: ALICE_EMAIL }, ALICE_USER);
    expect(r.status).toBe('BLOCKED_SELF');
  });

  it('SENT + stores hash-only + emails B when B exists', async () => {
    enableAccountMergeFlag();
    const r = await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL });
    expect(r.status).toBe('SENT');
    expect(r.expiresInMinutes).toBe(30);

    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(AccountMergeRequests)
      .where({ targetEmail: BOB_EMAIL, status: 'PENDING' })
      .orderBy('createdAt desc')
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.tokenHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBe('PENDING');
    // Plaintext MUST NOT be stored.
    expect(row.tokenHashHex).not.toMatch(/^amt_/);

    // sendNotificationEmail was called: verify via FailedEmails queue
    // (no SMTP transport in unit tests → mail-client queues the attempt).
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const [email] = await SELECT.from(FailedEmails)
      .where({ to: BOB_EMAIL })
      .orderBy('createdAt desc')
      .limit(1);
    expect(email).toBeTruthy();
    expect(email.to).toBe(BOB_EMAIL);
    expect(email.subject).toContain('merging');
  });

  it('RATE_LIMITED after 5 pending requests in an hour', async () => {
    enableAccountMergeFlag();

    // Clear existing AMRs for alice first to reset state.
    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    await DELETE.from(AccountMergeRequests).where({ requesterUser_ID: aliceId });

    // Issue 5 requests — each should succeed (SENT).
    for (let i = 0; i < 5; i++) {
      enableAccountMergeFlag(); // stays fresh through rate-limit loop
      const r = await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL });
      expect(r.status).toBe('SENT');
    }

    // 6th request from the same caller must be RATE_LIMITED.
    enableAccountMergeFlag();
    const r6 = await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL });
    expect(r6.status).toBe('RATE_LIMITED');
  });
});
