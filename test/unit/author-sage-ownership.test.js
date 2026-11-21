// test/unit/author-sage-ownership.test.js
//
// Task 4 TDD — proves that AuthorSageService ownership checks isolate users
// even though the service gate is `authenticated-user` (not `Tutorial.Author`).
//
// Two distinct user identities (author-a / author-b) are set up. The test
// verifies:
//   (a) author-a's GET /author/MyOwnedTutorials returns ONLY author-a's
//       tutorials, not author-b's.
//   (b) author-a's POST reviewTutorial on author-b's tutorial is rejected
//       with 403 "Not the owner".
//
// This demonstrates that the ownership check in AuthorSageService's handler is
// intact: even when the production service gate is weaker (`authenticated-user`),
// per-user data isolation is preserved by the before-READ ownership stamp and
// assertOwnership.
//
// NOTE ON SERVICE GATE vs. UNIT TEST:
//   AuthorSageService has `@requires: 'authenticated-user'` while AuthorService
//   has `@requires: 'Tutorial.Author'`. When serving the full main project (as
//   this test does), both services are co-mounted at `/author/`, and CAP's OData
//   adapter enforces the more restrictive AuthorService gate (`Tutorial.Author`).
//   This test uses the named `author` mock user (Tutorial.Author + authenticated-user)
//   to pass the service gate, then verifies HANDLER-LEVEL ownership isolation.
//   In production, IAS tokens satisfy `authenticated-user` and reach AuthorSageService
//   directly (without Tutorial.Author), and the same ownership check applies.
//
// Mock auth: basic-auth username → req.user.id. resolveUserSapId falls back to
// user.id, so sapId = username. We seed Users rows keyed on those sapIds.

import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Stable IDs for deterministic cleanup.
const ALICE_ID   = 'aaaaaaaa-sage-0000-0000-000000000001';
const BOB_ID     = 'aaaaaaaa-sage-0000-0000-000000000002';
const ALICE_UUID = 'bbbbbbbb-sage-0000-0000-000000000001';
const BOB_UUID   = 'bbbbbbbb-sage-0000-0000-000000000002';
const T_ALICE_ID = 'cccccccc-sage-0000-0000-000000000001';
const T_BOB_ID   = 'cccccccc-sage-0000-0000-000000000002';

// `author` is a named .cdsrc.json mock user with Tutorial.Author + authenticated-user.
// Its user.id is 'author', so resolveUserSapId → 'author' → matches Users.sapId.
// We use a SAP-ID-safe alias for alice's sapId so it doesn't collide with any
// other test fixture that seeds a Users row keyed on 'author'.
const ALICE_SAP_ID = 'sage-author-a';   // alice's Users.sapId
const BOB_SAP_ID   = 'sage-author-b';   // bob's Users.sapId (no corresponding mock user)

// alice authenticates as a user whose req.user.id = ALICE_SAP_ID. We achieve
// this by using the alias directly as the basic-auth username in mock-auth mode.
// Since ALICE_SAP_ID ('sage-author-a') is NOT a named user in .cdsrc.json, it
// would not have Tutorial.Author. So for HTTP calls we use the named `author`
// user AND seed Alice's Users row with sapId = 'author'.
const AUTHOR_A_USERNAME = 'author';     // named .cdsrc.json mock: Tutorial.Author + authenticated-user
// Bob has no corresponding HTTP-accessible user; cross-user ownership is proven
// by alice FAILING to review bob's tutorial (the ownership check only needs
// alice's perspective — if the check rejects alice→bob, isolation is proven).

beforeEach(async () => {
  const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');

  await DELETE.from(TutorialMeta).where({ tutorial_ID: { in: [T_ALICE_ID, T_BOB_ID] } });
  await DELETE.from(Tutorials).where({ ID: { in: [T_ALICE_ID, T_BOB_ID] } });
  await DELETE.from(Users).where({ ID: { in: [ALICE_ID, BOB_ID] } });

  // Alice's Users row is keyed on sapId = 'author' (the mock username), so
  // resolveUserSapId({id:'author'}) → 'author' → SELECT from Users where sapId='author'.
  // Bob has his own row linked to bob's tutorial via ownerEmail.
  await INSERT.into(Users).entries([
    { ID: ALICE_ID, uuid: ALICE_UUID, sapId: AUTHOR_A_USERNAME, legacyId: 98001, email: 'sage-author-a@test.example' },
    { ID: BOB_ID,   uuid: BOB_UUID,   sapId: BOB_SAP_ID,         legacyId: 98002, email: 'sage-author-b@test.example'  },
  ]);

  await INSERT.into(Tutorials).entries([
    { ID: T_ALICE_ID, slug: 'sage-alice-tutorial', title: 'Alice Tutorial', status: 'ACTIVE' },
    { ID: T_BOB_ID,   slug: 'sage-bob-tutorial',   title: 'Bob Tutorial',   status: 'ACTIVE' },
  ]);

  // ownerEmail links tutorial to owner's Users row (priority-3 signal in
  // MyTutorialsView; inner-joined on Users.email). Email must match Users.email above.
  await INSERT.into(TutorialMeta).entries([
    { ID: 'dddddddd-sage-0001', tutorial_ID: T_ALICE_ID, owner: AUTHOR_A_USERNAME, ownerEmail: 'sage-author-a@test.example', monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 98101 },
    { ID: 'dddddddd-sage-0002', tutorial_ID: T_BOB_ID,   owner: BOB_SAP_ID,         ownerEmail: 'sage-author-b@test.example',  monitoredStatus: 'ACTIVE', notificationNumber: 0, legacyId: 98102 },
  ]);
});

afterEach(async () => {
  const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialMeta).where({ tutorial_ID: { in: [T_ALICE_ID, T_BOB_ID] } });
  await DELETE.from(Tutorials).where({ ID: { in: [T_ALICE_ID, T_BOB_ID] } });
  await DELETE.from(Users).where({ ID: { in: [ALICE_ID, BOB_ID] } });
});

describe('AuthorSageService ownership isolation (Task 4)', () => {

  describe('(a) MyOwnedTutorials — caller-scoped read', () => {
    it('author-a sees their own tutorial but NOT author-b\'s', async () => {
      const { GET } = project;
      const res = await GET(
        '/author/MyOwnedTutorials',
        { auth: { username: AUTHOR_A_USERNAME, password: '' }, validateStatus: () => true }
      );
      // AuthorSageService's before-READ handler stamps WHERE userId = alice's uuid,
      // so only alice's tutorial should appear. Bob's tutorial must NOT appear.
      expect(res.status).toBe(200);
      const ids = (res.data?.value ?? []).map((r) => r.ID);
      expect(ids).toContain(T_ALICE_ID);
      expect(ids).not.toContain(T_BOB_ID);
    });
  });

  describe('(b) reviewTutorial — ownership gate', () => {
    it('author-a calling reviewTutorial on author-b\'s tutorial is rejected (403 Not the owner)', async () => {
      const { POST } = project;
      // POST to the qualified AuthorSageService action name. The main AuthorService
      // also has reviewTutorial, so we use the full qualification to route to
      // AuthorSageService's handler specifically.
      const res = await POST(
        '/author/AuthorSageService.reviewTutorial',
        { tutorialId: T_BOB_ID },
        { auth: { username: AUTHOR_A_USERNAME, password: '' }, validateStatus: () => true }
      );
      // AuthorSageService's assertOwnership check: author-a does NOT own T_BOB_ID,
      // so the handler must return 403 with "Not the owner". This proves that
      // the ownership check survives the authenticated-user gate.
      expect(res.status).toBe(403);
      expect(String(res.data?.error?.message ?? '')).toMatch(/[Nn]ot the owner/);
    });

    it('author-a calling reviewTutorial on their own tutorial succeeds', async () => {
      const { POST } = project;
      const res = await POST(
        '/author/AuthorSageService.reviewTutorial',
        { tutorialId: T_ALICE_ID },
        { auth: { username: AUTHOR_A_USERNAME, password: '' }, validateStatus: () => true }
      );
      // author-a owns T_ALICE_ID → ownership check passes → review succeeds.
      expect(res.status).toBe(200);
      expect(res.data?.reviewedDate).toBeTruthy();
      expect(res.data?.notificationNumber).toBe(0);
    });
  });

});
