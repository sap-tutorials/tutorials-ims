// test/unit/account-merge-extended.test.js
//
// Vitest/ESM tests for the extended mergeAccounts() covering
// UserIdentities, EventRegistrations, and CatGameAwards (#2651).
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot CAP with in-memory SQLite once for this file.
// SELECT / INSERT / DELETE / UPDATE become globals via cds.test().
cds.test('serve', '--project', '.', '--in-memory');

const { mergeAccounts } = await import('../../srv/lib/account-merge.js');

describe('mergeAccounts — extended tables (#2651)', () => {
  let db;
  let Users, Events, UserIdentities, EventRegistrations, CatGameAwards,
      Puzzles, PuzzleProgress, PetSubmissions, UserMetaData, UserLearningPreferences,
      SessionFavorites, DeveloperEnvironmentTabs, Petoberfests;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Users, Events, UserIdentities, EventRegistrations, CatGameAwards,
       Puzzles, PuzzleProgress, PetSubmissions, UserMetaData, UserLearningPreferences,
       SessionFavorites, DeveloperEnvironmentTabs, Petoberfests } =
      cds.entities('com.sap.developers.ims'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: EventRegistrations repoint + dedupe
  // ─────────────────────────────────────────────────────────────────────────
  it('EventRegistrations: secondary-only reg is repointed to primary', async () => {
    const pid = cds.utils.uuid();
    const sid = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: pid,
      email: `ev-p1-${pid}@test.example`, legacyId: null,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: sid,
      email: `ev-s1-${sid}@test.example`, legacyId: null,
    });

    const primaryUser = await SELECT.one.from(Users).where({ uuid: pid });
    const secondaryUser = await SELECT.one.from(Users).where({ uuid: sid });

    // Insert a Devtoberfest event
    const evId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: evId,
      name: `DevtoberFest-ev1-${evId}`,
      eventType: 'DEVTOBERFEST',
      startDate: '2026-09-21T00:00:00Z',
      endDate: '2026-10-18T00:00:00Z',
    });

    // Secondary has one registration; primary has none
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: secondaryUser.ID,
      event_ID: evId,
      joinedAt: '2026-08-10T00:00:00Z',
    });

    await mergeAccounts(pid, sid);

    // Exactly one registration for this event; owned by primary
    const regs = await SELECT.from(EventRegistrations).where({ event_ID: evId });
    expect(regs.length).toBe(1);
    expect(regs[0].user_ID).toBe(primaryUser.ID);
    // No registrations left on secondary
    const secRegs = await SELECT.from(EventRegistrations)
      .where({ user_ID: secondaryUser.ID, event_ID: evId });
    expect(secRegs.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: CatGameAwards sum-and-cap, keeps all days
  // ─────────────────────────────────────────────────────────────────────────
  it('CatGameAwards: same-day collision summed+clamped; distinct day carried over', async () => {
    const pid = cds.utils.uuid();
    const sid = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: pid,
      email: `cg-p1-${pid}@test.example`, legacyId: null,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: sid,
      email: `cg-s1-${sid}@test.example`, legacyId: null,
    });

    const primaryUser = await SELECT.one.from(Users).where({ uuid: pid });
    const secondaryUser = await SELECT.one.from(Users).where({ uuid: sid });

    const evId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: evId,
      name: `DevtoberFest-ev2-${evId}`,
      eventType: 'DEVTOBERFEST',
      startDate: '2026-09-21T00:00:00Z',
      endDate: '2026-10-18T00:00:00Z',
    });

    // Primary: day 2026-09-21, 5 pts
    await INSERT.into(CatGameAwards).entries({
      user_ID: primaryUser.ID, event_ID: evId, awardDate: '2026-09-21', points: 5,
    });
    // Secondary: same day (collision), 5 pts
    await INSERT.into(CatGameAwards).entries({
      user_ID: secondaryUser.ID, event_ID: evId, awardDate: '2026-09-21', points: 5,
    });
    // Secondary: distinct day 2026-09-22, 5 pts
    await INSERT.into(CatGameAwards).entries({
      user_ID: secondaryUser.ID, event_ID: evId, awardDate: '2026-09-22', points: 5,
    });

    await mergeAccounts(pid, sid);

    // No awards left on secondary
    const secLeft = await SELECT.from(CatGameAwards).where({ user_ID: secondaryUser.ID });
    expect(secLeft.length).toBe(0);

    const awards = await SELECT.from(CatGameAwards)
      .where({ user_ID: primaryUser.ID, event_ID: evId })
      .orderBy('awardDate');

    expect(awards.length).toBe(2);

    const day21 = awards.find(a => a.awardDate === '2026-09-21');
    const day22 = awards.find(a => a.awardDate === '2026-09-22');

    // 5 + 5 = 10, clamped to daily cap of 5
    expect(day21).toBeTruthy();
    expect(day21.points).toBe(5);

    // Distinct day carried over unchanged
    expect(day22).toBeTruthy();
    expect(day22.points).toBe(5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3a: UserIdentities — distinct subjects repointed to primary
  // ─────────────────────────────────────────────────────────────────────────
  it('UserIdentities: distinct issuer+subject repointed; both end up on primary', async () => {
    const pid = cds.utils.uuid();
    const sid = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: pid,
      email: `ui-p1-${pid}@test.example`, legacyId: null,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: sid,
      email: `ui-s1-${sid}@test.example`, legacyId: null,
    });

    const primaryUser = await SELECT.one.from(Users).where({ uuid: pid });
    const secondaryUser = await SELECT.one.from(Users).where({ uuid: sid });

    // Primary has one link; secondary has a DIFFERENT subject → should be moved
    await INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(),
      user_ID: primaryUser.ID,
      issuer: 'https://x',
      subject: 'subj-prim',
    });
    await INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(),
      user_ID: secondaryUser.ID,
      issuer: 'https://x',
      subject: 'subj-sec',
    });

    await mergeAccounts(pid, sid);

    // Both links now on primary
    const primLinks = await SELECT.from(UserIdentities).where({ user_ID: primaryUser.ID });
    expect(primLinks.length).toBe(2);
    expect(primLinks.map(l => l.subject).sort()).toEqual(['subj-prim', 'subj-sec'].sort());

    // None left on secondary
    const secLinks = await SELECT.from(UserIdentities).where({ user_ID: secondaryUser.ID });
    expect(secLinks.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3b: UserIdentities — defensive dup-delete path via raw UPDATE setup.
  //
  // @assert.unique.issuerSubject compiles to a DB-level UNIQUE(issuer, subject)
  // making two concurrent rows with the same (issuer, subject) impossible via
  // standard INSERT. We simulate the "primary already holds this link" state by:
  //   1. Inserting the link on secondary first (no conflict yet).
  //   2. Raw-updating its user_ID to primary (user_ID is not part of the unique key).
  //      This is the exact scenario that occurs when a previous mergeAccounts call
  //      moved the link — and then a new secondary appears with the same link from
  //      a race window.
  // The test then verifies that the secondary has 0 rows after the merge (all links
  // on primary) and that the primary's pre-existing link count is correct.
  // ─────────────────────────────────────────────────────────────────────────
  it('UserIdentities: pre-existing primary links preserved; secondary links repointed', async () => {
    const pid = cds.utils.uuid();
    const sid = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: pid,
      email: `ui-p2-${pid}@test.example`, legacyId: null,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: sid,
      email: `ui-s2-${sid}@test.example`, legacyId: null,
    });

    const primaryUser = await SELECT.one.from(Users).where({ uuid: pid });
    const secondaryUser = await SELECT.one.from(Users).where({ uuid: sid });

    // Step 1: Insert link (iss:'https://race-iss', sub:'link-A') on secondary.
    const linkAId = cds.utils.uuid();
    await INSERT.into(UserIdentities).entries({
      ID: linkAId, user_ID: secondaryUser.ID,
      issuer: 'https://race-iss', subject: 'link-A',
    });

    // Step 2: Move it to primary via raw UPDATE of user_ID (no UNIQUE violation —
    //   user_ID is not part of the (issuer, subject) unique key).
    //   This simulates: primary already holds 'link-A' from a prior login or merge.
    await db.run(
      `UPDATE com_sap_developers_ims_UserIdentities SET user_ID = ? WHERE ID = ?`,
      [primaryUser.ID, linkAId]
    );

    // Step 3: Add a distinct secondary link (different subject) to cover the repoint path.
    await INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(), user_ID: secondaryUser.ID,
      issuer: 'https://race-iss', subject: 'link-B',
    });

    await mergeAccounts(pid, sid);

    // Primary must have both links (link-A pre-existing + link-B repointed from secondary).
    const primLinks = await SELECT.from(UserIdentities).where({ user_ID: primaryUser.ID });
    expect(primLinks.length).toBe(2);
    const subjects = primLinks.map(l => l.subject).sort();
    expect(subjects).toEqual(['link-A', 'link-B']);

    // None left on secondary.
    const secLinks = await SELECT.from(UserIdentities).where({ user_ID: secondaryUser.ID });
    expect(secLinks.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4 (optional): per-event cap trim
  // ─────────────────────────────────────────────────────────────────────────
  it('CatGameAwards: per-event 100-point cap trimmed (21 days × 5 = 105 → 100)', async () => {
    const pid = cds.utils.uuid();
    const sid = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: pid,
      email: `cap-p1-${pid}@test.example`, legacyId: null,
    });
    await INSERT.into(Users).entries({
      ID: cds.utils.uuid(), uuid: sid,
      email: `cap-s1-${sid}@test.example`, legacyId: null,
    });

    const primaryUser = await SELECT.one.from(Users).where({ uuid: pid });
    const secondaryUser = await SELECT.one.from(Users).where({ uuid: sid });

    const evId = cds.utils.uuid();
    await INSERT.into(Events).entries({
      ID: evId,
      name: `DevtoberFest-ev3-${evId}`,
      eventType: 'DEVTOBERFEST',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-10-31T00:00:00Z',
    });

    // Primary: 11 distinct days × 5 pts = 55 pts
    for (let d = 1; d <= 11; d++) {
      const day = String(d).padStart(2, '0');
      await INSERT.into(CatGameAwards).entries({
        user_ID: primaryUser.ID, event_ID: evId,
        awardDate: `2026-09-${day}`, points: 5,
      });
    }
    // Secondary: 10 distinct days × 5 pts = 50 pts (total combined = 105)
    for (let d = 12; d <= 21; d++) {
      const day = String(d).padStart(2, '0');
      await INSERT.into(CatGameAwards).entries({
        user_ID: secondaryUser.ID, event_ID: evId,
        awardDate: `2026-09-${day}`, points: 5,
      });
    }

    await mergeAccounts(pid, sid);

    // Total for this event must be exactly 100 (trimmed from 105)
    const awards = await SELECT.from(CatGameAwards)
      .where({ user_ID: primaryUser.ID, event_ID: evId });
    const total = awards.reduce((n, r) => n + (r.points ?? 0), 0);
    expect(total).toBe(100);

    // None left on secondary
    const secLeft = await SELECT.from(CatGameAwards).where({ user_ID: secondaryUser.ID });
    expect(secLeft.filter(a => a.event_ID === evId).length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 5: PuzzleProgress — unique (user,puzzle) — keep primary's row
  // ─────────────────────────────────────────────────────────────────────────
  it('PuzzleProgress: on (user,puzzle) conflict, primary row is kept and secondary dropped', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `pp-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `pp-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });
    const puz = cds.utils.uuid();
    await INSERT.into(Puzzles).entries({ ID: puz, slug: `puz-${puz}` });
    await INSERT.into(PuzzleProgress).entries({ ID: cds.utils.uuid(), user_ID: P.ID, puzzle_ID: puz, filledGrid: '{"0,0":"A"}' });
    await INSERT.into(PuzzleProgress).entries({ ID: cds.utils.uuid(), user_ID: S.ID, puzzle_ID: puz, filledGrid: '{"0,0":"Z"}' });
    await mergeAccounts(pid, sid);
    const rows = await SELECT.from(PuzzleProgress).where({ puzzle_ID: puz });
    expect(rows.length).toBe(1);
    expect(rows[0].user_ID).toBe(P.ID);
    expect(rows[0].filledGrid).toBe('{"0,0":"A"}'); // primary kept
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 6: UserLearningPreferences — PK user_ID only — A wins if present
  // ─────────────────────────────────────────────────────────────────────────
  it('UserLearningPreferences: if primary has a row, secondary is deleted; else secondary is moved', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `ulp-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `ulp-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    // Subcase 1: primary has row, secondary has row → secondary deleted
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: P.ID, deployment: 'cloud', role: 'developer',
    });
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: S.ID, deployment: 'onprem', role: 'architect',
    });
    await mergeAccounts(pid, sid);
    const after1 = await SELECT.from(UserLearningPreferences).where({ user_ID: P.ID });
    expect(after1.length).toBe(1);
    expect(after1[0].deployment).toBe('cloud');
    const after1Sec = await SELECT.from(UserLearningPreferences).where({ user_ID: S.ID });
    expect(after1Sec.length).toBe(0);

    // Subcase 2: primary has no row, secondary has one → secondary moved
    const pid2 = cds.utils.uuid(), sid2 = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid2, email: `ulp-p2-${pid2}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid2, email: `ulp-s2-${sid2}@test.example` });
    const P2 = await SELECT.one.from(Users).where({ uuid: pid2 });
    const S2 = await SELECT.one.from(Users).where({ uuid: sid2 });
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: S2.ID, deployment: 'cloud', role: 'sysadmin',
    });
    await mergeAccounts(pid2, sid2);
    const after2 = await SELECT.from(UserLearningPreferences).where({ user_ID: P2.ID });
    expect(after2.length).toBe(1);
    expect(after2[0].deployment).toBe('cloud');
    expect(after2[0].role).toBe('sysadmin');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 7: UserMetaData — PK (user_ID,key) — A wins per key; distinct keys both end on A
  // ─────────────────────────────────────────────────────────────────────────
  it('UserMetaData: same key → A kept; distinct keys → both on A', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `umd-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `umd-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    // Primary has key='lang' → value='en'
    await INSERT.into(UserMetaData).entries({
      user_ID: P.ID, key: 'lang', value: 'en',
    });
    // Secondary has same key='lang' → value='de' (should be dropped)
    await INSERT.into(UserMetaData).entries({
      user_ID: S.ID, key: 'lang', value: 'de',
    });
    // Secondary has distinct key='theme' → value='dark' (should be moved)
    await INSERT.into(UserMetaData).entries({
      user_ID: S.ID, key: 'theme', value: 'dark',
    });

    await mergeAccounts(pid, sid);

    const rows = await SELECT.from(UserMetaData).where({ user_ID: P.ID }).orderBy('key');
    expect(rows.length).toBe(2);
    const langRow = rows.find(r => r.key === 'lang');
    const themeRow = rows.find(r => r.key === 'theme');
    expect(langRow).toBeTruthy();
    expect(langRow.value).toBe('en'); // primary kept
    expect(themeRow).toBeTruthy();
    expect(themeRow.value).toBe('dark'); // secondary moved
    const secRows = await SELECT.from(UserMetaData).where({ user_ID: S.ID });
    expect(secRows.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 8: SessionFavorites — unique (user,sourceType,sessionRef) — one per combo on A
  // ─────────────────────────────────────────────────────────────────────────
  it('SessionFavorites: same (sourceType,sessionRef) → one on A; distinct → both on A', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `sf-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `sf-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    // Primary: TECHED / session-1
    await INSERT.into(SessionFavorites).entries({
      ID: cds.utils.uuid(), user_ID: P.ID, sourceType: 'TECHED', sessionRef: 'session-1',
    });
    // Secondary: same (TECHED, session-1) — should be dropped
    await INSERT.into(SessionFavorites).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, sourceType: 'TECHED', sessionRef: 'session-1',
    });
    // Secondary: distinct (DEVTOBERFEST, task-123) — should be moved
    await INSERT.into(SessionFavorites).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, sourceType: 'DEVTOBERFEST', sessionRef: 'task-123',
    });

    await mergeAccounts(pid, sid);

    const rows = await SELECT.from(SessionFavorites).where({ user_ID: P.ID }).orderBy('sessionRef');
    expect(rows.length).toBe(2);
    const teched = rows.find(r => r.sourceType === 'TECHED');
    const devtoberfest = rows.find(r => r.sourceType === 'DEVTOBERFEST');
    expect(teched).toBeTruthy();
    expect(teched.sessionRef).toBe('session-1');
    expect(devtoberfest).toBeTruthy();
    expect(devtoberfest.sessionRef).toBe('task-123');
    const secRows = await SELECT.from(SessionFavorites).where({ user_ID: S.ID });
    expect(secRows.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 9: PetSubmissions — no per-user uniqueness — all B rows repoint to A
  // ─────────────────────────────────────────────────────────────────────────
  it('PetSubmissions: straight repoint — all B rows end on A', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `ps-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `ps-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    const petA = cds.utils.uuid();
    const petB = cds.utils.uuid();
    await INSERT.into(Petoberfests).entries({ ID: petA, slug: `pet-${petA}` });
    await INSERT.into(Petoberfests).entries({ ID: petB, slug: `pet-${petB}` });

    // Primary has one submission
    await INSERT.into(PetSubmissions).entries({
      ID: cds.utils.uuid(), user_ID: P.ID, petoberfest_ID: petA,
    });
    // Secondary has two submissions (no uniqueness constraint, can be multiple per petoberfest)
    await INSERT.into(PetSubmissions).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, petoberfest_ID: petA,
    });
    await INSERT.into(PetSubmissions).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, petoberfest_ID: petB,
    });

    await mergeAccounts(pid, sid);

    const primaryRows = await SELECT.from(PetSubmissions).where({ user_ID: P.ID });
    expect(primaryRows.length).toBe(3);
    const secRows = await SELECT.from(PetSubmissions).where({ user_ID: S.ID });
    expect(secRows.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 10: DeveloperEnvironmentTabs — no per-user uniqueness — all B rows repoint to A
  // ─────────────────────────────────────────────────────────────────────────
  it('DeveloperEnvironmentTabs: straight repoint — all B rows end on A', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `det-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `det-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    // Primary has one tab
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID: cds.utils.uuid(), user_ID: P.ID, tabName: 'Tab-A', tabOrder: 1,
    });
    // Secondary has two tabs
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, tabName: 'Tab-B', tabOrder: 1,
    });
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID: cds.utils.uuid(), user_ID: S.ID, tabName: 'Tab-C', tabOrder: 2,
    });

    await mergeAccounts(pid, sid);

    const primaryRows = await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: P.ID });
    expect(primaryRows.length).toBe(3);
    const secRows = await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: S.ID });
    expect(secRows.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Task 2 tests: TaskRecords dedupe + rollup recompute + idempotency
// ═════════════════════════════════════════════════════════════════════════════

describe('mergeAccounts — Task 2 (#2641)', () => {
  let db;
  let Users, TaskRecords, SecondaryAccounts;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Users, TaskRecords, SecondaryAccounts } =
      cds.entities('com.sap.developers.ims'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: TaskRecords dedupe on (taskType, taskLegacyId)
  // ─────────────────────────────────────────────────────────────────────────
  it('TaskRecords: duplicate (taskType,taskLegacyId) dedupes keeping COMPLETED', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `tr-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `tr-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });
    await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: P.ID, taskType: 'TUTORIAL', taskLegacyId: 42, status: 'IN_PROGRESS' });
    await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: S.ID, taskType: 'TUTORIAL', taskLegacyId: 42, status: 'COMPLETED', completionDate: '2026-01-01T00:00:00Z' });
    await mergeAccounts(pid, sid);
    const rows = await SELECT.from(TaskRecords).where({ user_ID: P.ID, taskType: 'TUTORIAL', taskLegacyId: 42 });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('COMPLETED');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: Idempotency guard — ALREADY_MERGED
  // ─────────────────────────────────────────────────────────────────────────
  it('throws ALREADY_MERGED when secondary already merged', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `idp-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `idp-s-${sid}@test.example` });

    // First merge should succeed
    await mergeAccounts(pid, sid);

    // Second merge with same uuids should reject with ALREADY_MERGED
    await expect(mergeAccounts(pid, sid)).rejects.toThrow('ALREADY_MERGED');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3: movedCounts includes taskRecordsDeduped
  // ─────────────────────────────────────────────────────────────────────────
  it('movedCounts includes taskRecordsDeduped count', async () => {
    const pid = cds.utils.uuid(), sid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `mc-p-${pid}@test.example` });
    await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `mc-s-${sid}@test.example` });
    const P = await SELECT.one.from(Users).where({ uuid: pid });
    const S = await SELECT.one.from(Users).where({ uuid: sid });

    // Create duplicate TaskRecords to be deduped
    await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: P.ID, taskType: 'TUTORIAL', taskLegacyId: 100, status: 'IN_PROGRESS' });
    await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: S.ID, taskType: 'TUTORIAL', taskLegacyId: 100, status: 'COMPLETED', completionDate: '2026-01-01T00:00:00Z' });

    const result = await mergeAccounts(pid, sid);

    expect(result).toHaveProperty('movedCounts');
    expect(result.movedCounts).toHaveProperty('taskRecordsDeduped');
    expect(result.movedCounts.taskRecordsDeduped).toBe(1);
  });
});
