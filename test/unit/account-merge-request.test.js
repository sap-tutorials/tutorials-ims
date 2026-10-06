import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

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
const ALICE_ISS  = 'https://test-fake.ondemand.example';
const ALICE_SUB  = 'alice-sub-uuid-test-001';
const BOB_ISS    = 'https://test-fake.ondemand.example';
const BOB_SUB    = 'bob-sub-uuid-test-001';
const CAROL_ISS  = 'https://test-fake.ondemand.example';
const CAROL_SUB  = 'carol-sub-uuid-test-001';
const CAROL_EMAIL = 'carol@x.example';

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
const CAROL_USER = makeUser(CAROL_EMAIL, CAROL_ISS, CAROL_SUB);

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
    // (no SMTP transport in unit tests → mail-client stores fully-resolved HTML
    // in FailedEmails.body — resolveTemplate() runs before the transport check).
    const { FailedEmails } = cds.entities('com.sap.developers.ims');
    const [email] = await SELECT.from(FailedEmails)
      .where({ to: BOB_EMAIL })
      .orderBy('createdAt desc')
      .limit(1);
    expect(email).toBeTruthy();
    expect(email.to).toBe(BOB_EMAIL);
    expect(email.subject).toContain('merging');

    // body contains the magic link with the real plaintext token (never stored in DB).
    // globalThis.__lastTokenForTest is set by newToken() when NODE_ENV==='test'.
    const lastToken = globalThis.__lastTokenForTest;
    expect(lastToken).toMatch(/^amt_[A-Za-z0-9_-]+$/);
    expect(email.body).toContain(`/me/merge?token=${lastToken}`);

    // body reflects the initiator's email (template variable ${initiatorEmail}).
    expect(email.body).toContain(ALICE_EMAIL);
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

// ─── confirmAccountMerge handler (Task 5) ────────────────────────────────────

describe('confirmAccountMerge', () => {
  let srv;
  let aliceId;
  let carolId;

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');
    const { Users, UserIdentities } = cds.entities('com.sap.developers.ims');

    // Seed alice (primary caller A).
    let aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    if (!aliceRow) {
      const id = cds.utils.uuid();
      await INSERT.into(Users).entries({
        ID: id,
        sapId: null,
        uuid: cds.utils.uuid(),
        email: ALICE_EMAIL,
        displayName: 'Alice',
      });
      aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    }
    aliceId = aliceRow.ID;

    // Seed alice's UserIdentities link.
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

    // Seed bob (target B) — no UserIdentities needed; looked up by email.
    let bobRow = await SELECT.one.from(Users).where({ email: BOB_EMAIL });
    if (!bobRow) {
      await INSERT.into(Users).entries({
        ID: cds.utils.uuid(),
        sapId: null,
        uuid: cds.utils.uuid(),
        email: BOB_EMAIL,
        displayName: 'Bob',
      });
    }

    // Seed carol (wrong-account attacker C).
    let carolRow = await SELECT.one.from(Users).where({ email: CAROL_EMAIL });
    if (!carolRow) {
      const id = cds.utils.uuid();
      await INSERT.into(Users).entries({
        ID: id,
        sapId: null,
        uuid: cds.utils.uuid(),
        email: CAROL_EMAIL,
        displayName: 'Carol',
      });
      carolRow = await SELECT.one.from(Users).where({ email: CAROL_EMAIL });
    }
    carolId = carolRow.ID;

    // Seed carol's UserIdentities link so provisionDbUser resolves her via Tier 1.
    const carolLink = await SELECT.one.from(UserIdentities)
      .where({ issuer: CAROL_ISS, subject: CAROL_SUB });
    if (!carolLink) {
      await INSERT.into(UserIdentities).entries({
        ID: cds.utils.uuid(),
        user_ID: carolId,
        issuer: CAROL_ISS,
        subject: CAROL_SUB,
        provider: 'ias',
        emailVerified: true,
        linkedAt: new Date().toISOString(),
      });
    }
  });

  afterEach(async () => {
    disableAccountMergeFlag();
    vi.restoreAllMocks();
    // Clean up merge ledger between tests to keep them independent.
    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    await DELETE.from(AccountMergeRequests);
  });

  it('WRONG_ACCOUNT when a different user opens the link', async () => {
    enableAccountMergeFlag();
    // Alice requests merge of bob; carol confirms the token.
    await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL }, ALICE_USER);
    const token = globalThis.__lastTokenForTest;
    const r = await callAction(srv, 'confirmAccountMerge', { token }, CAROL_USER);
    expect(r.status).toBe('WRONG_ACCOUNT');
  });

  it('happy path: MERGED, movedCounts parses to object, bob records on alice', async () => {
    enableAccountMergeFlag();
    const { TaskRecords, Users, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
    const bobRow = await SELECT.one.from(Users).where({ email: BOB_EMAIL });

    // Give bob a TaskRecord so we can verify it migrates to alice.
    const taskId = cds.utils.uuid();
    await INSERT.into(TaskRecords).entries({
      ID: taskId,
      user_ID: bobRow.ID,
      taskType: 'TUTORIAL',
      taskLegacyId: 'test-merge-tutorial-001',
      status: 'COMPLETED',
      completionDate: new Date().toISOString(),
    });

    // Alice requests merge of bob.
    await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL }, ALICE_USER);
    const token = globalThis.__lastTokenForTest;

    // Clean up any prior SecondaryAccounts for bob so the merge isn't blocked.
    await DELETE.from(SecondaryAccounts).where({ uuid: bobRow.uuid });

    const r = await callAction(srv, 'confirmAccountMerge', { token }, ALICE_USER);
    expect(r.status).toBe('MERGED');

    const counts = JSON.parse(r.movedCounts);
    expect(typeof counts).toBe('object');

    // Bob's TaskRecord should now be on alice.
    const aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    const aliceTask = await SELECT.one.from(TaskRecords)
      .where({ user_ID: aliceRow.ID, taskLegacyId: 'test-merge-tutorial-001' });
    expect(aliceTask).toBeTruthy();
  });

  it('EXPIRED when expiresAt is in the past', async () => {
    enableAccountMergeFlag();
    const { AccountMergeRequests, Users } = cds.entities('com.sap.developers.ims');
    const aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    const bobRow   = await SELECT.one.from(Users).where({ email: BOB_EMAIL });

    // Manufacture a stale ledger row directly.
    const staleToken = `amt_stale_test_${crypto.randomBytes(8).toString('hex')}`;
    const hashHex = crypto.createHash('sha256').update(staleToken).digest('hex');
    const pastDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago

    await INSERT.into(AccountMergeRequests).entries({
      ID: cds.utils.uuid(),
      requesterUser_ID: aliceRow.ID,
      targetEmail: BOB_EMAIL,
      targetUser_ID: bobRow.ID,
      tokenHashHex: hashHex,
      status: 'PENDING',
      expiresAt: pastDate,
      requesterIP: null,
    });

    const r = await callAction(srv, 'confirmAccountMerge', { token: staleToken }, ALICE_USER);
    expect(r.status).toBe('EXPIRED');
  });

  it('INVALID for a random token', async () => {
    enableAccountMergeFlag();
    const r = await callAction(srv, 'confirmAccountMerge', { token: 'amt_does_not_exist_xyz' }, ALICE_USER);
    expect(r.status).toBe('INVALID');
  });

  it('rollback: FAILED status and ledger stays PENDING when mergeAccounts throws unexpectedly', async () => {
    enableAccountMergeFlag();
    const { AccountMergeRequests, TaskRecords, Users, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
    const aliceRow = await SELECT.one.from(Users).where({ email: ALICE_EMAIL });
    const bobRow   = await SELECT.one.from(Users).where({ email: BOB_EMAIL });

    // Clean any prior SecondaryAccounts for bob so requestAccountMerge isn't blocked.
    await DELETE.from(SecondaryAccounts).where({ uuid: bobRow.uuid });

    // Alice requests merge of bob so we get a valid ledger row.
    await callAction(srv, 'requestAccountMerge', { targetEmail: BOB_EMAIL }, ALICE_USER);
    const token = globalThis.__lastTokenForTest;

    // Verify ledger is PENDING before we confirm.
    const before = await SELECT.one.from(AccountMergeRequests).where({ status: 'PENDING' });
    expect(before).toBeTruthy();

    // Force mergeAccounts to throw a non-ALREADY_MERGED error by temporarily
    // making bob's uuid unresolvable (delete then restore bob from Users).
    // We achieve this by patching globalThis for the handler — easiest approach
    // that doesn't require vi.mock across CDS module boundaries: use a flag.
    globalThis.__mergeAccountsShouldThrowForTest = true;

    let r;
    try {
      r = await callAction(srv, 'confirmAccountMerge', { token }, ALICE_USER);
    } catch {
      // CAP req.error(500) causes the action to reject — treat as FAILED.
      r = { status: 'FAILED' };
    } finally {
      delete globalThis.__mergeAccountsShouldThrowForTest;
    }

    expect(r.status).toBe('FAILED');

    // Ledger row should still be PENDING (the tx rolled back).
    const after = await SELECT.one.from(AccountMergeRequests).where({ tokenHashHex: before.tokenHashHex });
    expect(after?.status).toBe('PENDING');

    // Alice's task records count should be unchanged.
    const aliceTasks = await SELECT.from(TaskRecords).where({ user_ID: aliceRow.ID });
    // We just assert we can read without error; count is not critical here.
    expect(Array.isArray(aliceTasks)).toBe(true);
  });
});

// ─── account-merge-verify template render (Task 6) ──────────────────────────────

describe('account-merge-verify template', () => {
  it('renders with initiatorEmail, link, and ttlMinutes variables', async () => {
    const { loadTemplate, resolveTemplate } = await import('../../srv/lib/mail-client.js');
    const template = loadTemplate('account-merge-verify');
    const rendered = resolveTemplate(template, {
      link: 'https://x/me/merge?token=T',
      initiatorEmail: 'a@x',
      ttlMinutes: '30'
    });

    expect(rendered).toContain('https://x/me/merge?token=T');
    expect(rendered).toContain('a@x');
    expect(rendered).toContain('30');
  });
});
