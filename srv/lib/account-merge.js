import cds from '@sap/cds';

export async function mergeAccounts(primaryUuid, secondaryUuid) {
  const { Users, TaskRecords, PrizeRecords, AccomplishmentRecords,
          UserIdentities, EventRegistrations, CatGameAwards,
          PuzzleProgress, PetSubmissions, UserMetaData, UserLearningPreferences,
          SessionFavorites, DeveloperEnvironmentTabs,
          PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('account-merge');

  const primaryUser = await SELECT.one.from(Users).where({ uuid: primaryUuid });
  const secondaryUser = await SELECT.one.from(Users).where({ uuid: secondaryUuid });

  if (!primaryUser) throw new Error(`Primary user not found: ${primaryUuid}`);
  if (!secondaryUser) throw new Error(`Secondary user not found: ${secondaryUuid}`);

  // Idempotency guard: reject if secondary is already marked as MERGED
  const already = await SELECT.one.from(SecondaryAccounts).where({ uuid: secondaryUuid, status: 'MERGED' });
  if (already) { const e = new Error('ALREADY_MERGED'); e.code = 'ALREADY_MERGED'; throw e; }

  LOG.info(`Merging ${secondaryUuid} → ${primaryUuid}`);

  // Transfer task records
  await UPDATE(TaskRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Dedupe helper: (taskType, taskLegacyId) → keep COMPLETED over IN_PROGRESS, then earliest completionDate
  async function dedupeTaskRecords(TaskRecords, pId) {
    const rows = await SELECT.from(TaskRecords).where({ user_ID: pId });
    const groups = new Map(); // key -> rows[]
    for (const r of rows) {
      const k = `${r.taskType}|${r.taskLegacyId}`;
      (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
    }
    const rank = s => (s === 'COMPLETED' ? 2 : s === 'IN_PROGRESS' ? 1 : 0);
    let deduped = 0;
    for (const [, g] of groups) {
      if (g.length < 2) continue;
      g.sort((a, b) => rank(b.status) - rank(a.status)
        || String(a.completionDate ?? '9999').localeCompare(String(b.completionDate ?? '9999')));
      for (const loser of g.slice(1)) { await DELETE.from(TaskRecords).where({ ID: loser.ID }); deduped++; }
    }
    return deduped;
  }

  // Transfer prize records
  await UPDATE(PrizeRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Transfer accomplishment records
  await UPDATE(AccomplishmentRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

  // Repoint UserIdentities (dedupe on issuer+subject — drop a secondary link
  // that duplicates one the primary already has). (#2651)
  const secLinks = await SELECT.from(UserIdentities).where({ user_ID: secondaryUser.ID });
  for (const link of secLinks) {
    const dup = await SELECT.one.from(UserIdentities)
      .where({ user_ID: primaryUser.ID, issuer: link.issuer, subject: link.subject });
    if (dup) {
      await DELETE.from(UserIdentities)
        .where({ user_ID: secondaryUser.ID, issuer: link.issuer, subject: link.subject });
    } else {
      await UPDATE(UserIdentities)
        .where({ user_ID: secondaryUser.ID, issuer: link.issuer, subject: link.subject })
        .set({ user_ID: primaryUser.ID });
    }
  }

  // Repoint EventRegistrations (dedupe on event; keep earliest joinedAt). (#2651)
  const secRegs = await SELECT.from(EventRegistrations).where({ user_ID: secondaryUser.ID });
  for (const reg of secRegs) {
    const dup = await SELECT.one.from(EventRegistrations)
      .where({ user_ID: primaryUser.ID, event_ID: reg.event_ID });
    if (dup) {
      if (reg.joinedAt && (!dup.joinedAt || reg.joinedAt < dup.joinedAt)) {
        await UPDATE(EventRegistrations)
          .where({ user_ID: primaryUser.ID, event_ID: reg.event_ID })
          .set({ joinedAt: reg.joinedAt });
      }
      await DELETE.from(EventRegistrations)
        .where({ user_ID: secondaryUser.ID, event_ID: reg.event_ID });
    } else {
      await UPDATE(EventRegistrations)
        .where({ user_ID: secondaryUser.ID, event_ID: reg.event_ID })
        .set({ user_ID: primaryUser.ID });
    }
  }

  // Merge CatGameAwards (#2651): repoint secondary→primary. On same (event,
  // awardDate) collision, sum then clamp to the daily 5-cap. Then clamp each
  // event's grand total to 100 by trimming the most recent rows.
  const DAILY = 5, EVENT_CAP = 100;
  const secAwards = await SELECT.from(CatGameAwards).where({ user_ID: secondaryUser.ID });
  for (const a of secAwards) {
    const dup = await SELECT.one.from(CatGameAwards)
      .where({ user_ID: primaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate });
    if (dup) {
      const summed = Math.min((dup.points ?? 0) + (a.points ?? 0), DAILY);
      await UPDATE(CatGameAwards)
        .where({ user_ID: primaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate })
        .set({ points: summed });
      await DELETE.from(CatGameAwards)
        .where({ user_ID: secondaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate });
    } else {
      await UPDATE(CatGameAwards)
        .where({ user_ID: secondaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate })
        .set({ user_ID: primaryUser.ID });
    }
  }
  // Per-event cap: trim most-recent rows down until total <= EVENT_CAP.
  const events = [...new Set(
    (await SELECT.from(CatGameAwards).where({ user_ID: primaryUser.ID })).map(r => r.event_ID))];
  for (const eid of events) {
    const rows = (await SELECT.from(CatGameAwards).where({ user_ID: primaryUser.ID, event_ID: eid }))
      .sort((x, y) => String(y.awardDate).localeCompare(String(x.awardDate))); // newest first
    let total = rows.reduce((n, r) => n + (r.points ?? 0), 0);
    for (const r of rows) {
      if (total <= EVENT_CAP) break;
      const over = total - EVENT_CAP;
      const trim = Math.min(over, r.points ?? 0);
      await UPDATE(CatGameAwards)
        .where({ user_ID: primaryUser.ID, event_ID: eid, awardDate: r.awardDate })
        .set({ points: (r.points ?? 0) - trim });
      total -= trim;
    }
  }

  // Puzzle progress: unique (user,puzzle) — keep primary's row on conflict.
  async function transferPuzzleProgress(PuzzleProgress, pId, sId) {
    let moved = 0;
    const rows = await SELECT.from(PuzzleProgress).where({ user_ID: sId });
    for (const r of rows) {
      const dup = await SELECT.one.from(PuzzleProgress).where({ user_ID: pId, puzzle_ID: r.puzzle_ID });
      if (dup) await DELETE.from(PuzzleProgress).where({ ID: r.ID });
      else { await UPDATE(PuzzleProgress).where({ ID: r.ID }).set({ user_ID: pId }); moved++; }
    }
    return moved;
  }
  // Pet submissions: no per-user uniqueness — straight repoint.
  async function transferPetSubmissions(PetSubmissions, pId, sId) {
    const r = await UPDATE(PetSubmissions).where({ user_ID: sId }).set({ user_ID: pId });
    return r | 0;
  }
  // Developer environment tabs: has ID, no per-user uniqueness — straight repoint.
  async function transferEnvTabs(DeveloperEnvironmentTabs, pId, sId) {
    const r = await UPDATE(DeveloperEnvironmentTabs).where({ user_ID: sId }).set({ user_ID: pId });
    return r | 0;
  }
  // Session favorites: unique (user,sourceType,sessionRef) — drop secondary dup.
  async function transferSessionFavorites(SessionFavorites, pId, sId) {
    let moved = 0;
    const rows = await SELECT.from(SessionFavorites).where({ user_ID: sId });
    for (const r of rows) {
      const dup = await SELECT.one.from(SessionFavorites)
        .where({ user_ID: pId, sourceType: r.sourceType, sessionRef: r.sessionRef });
      if (dup) await DELETE.from(SessionFavorites).where({ ID: r.ID });
      else { await UPDATE(SessionFavorites).where({ ID: r.ID }).set({ user_ID: pId }); moved++; }
    }
    return moved;
  }
  // UserMetaData: PK (user_ID,key), NO ID column — A wins per key; else move B's.
  async function transferUserMetaData(UserMetaData, pId, sId) {
    let moved = 0;
    const rows = await SELECT.from(UserMetaData).where({ user_ID: sId });
    for (const r of rows) {
      const dup = await SELECT.one.from(UserMetaData).where({ user_ID: pId, key: r.key });
      if (dup) await DELETE.from(UserMetaData).where({ user_ID: sId, key: r.key });
      else { await UPDATE(UserMetaData).where({ user_ID: sId, key: r.key }).set({ user_ID: pId }); moved++; }
    }
    return moved;
  }
  // UserLearningPreferences: PK user_ID only, NO ID — A wins if it has a row; else move B's.
  async function transferLearningPrefs(UserLearningPreferences, pId, sId) {
    const primary = await SELECT.one.from(UserLearningPreferences).where({ user_ID: pId });
    if (primary) { await DELETE.from(UserLearningPreferences).where({ user_ID: sId }); return 0; }
    const sec = await SELECT.one.from(UserLearningPreferences).where({ user_ID: sId });
    if (!sec) return 0;
    await UPDATE(UserLearningPreferences).where({ user_ID: sId }).set({ user_ID: pId });
    return 1;
  }

  const moved = {};
  moved.puzzleProgress   = await transferPuzzleProgress(PuzzleProgress, primaryUser.ID, secondaryUser.ID);
  moved.petSubmissions   = await transferPetSubmissions(PetSubmissions, primaryUser.ID, secondaryUser.ID);
  moved.envTabs          = await transferEnvTabs(DeveloperEnvironmentTabs, primaryUser.ID, secondaryUser.ID);
  moved.sessionFavorites = await transferSessionFavorites(SessionFavorites, primaryUser.ID, secondaryUser.ID);
  moved.userMetaData     = await transferUserMetaData(UserMetaData, primaryUser.ID, secondaryUser.ID);
  moved.learningPrefs    = await transferLearningPrefs(UserLearningPreferences, primaryUser.ID, secondaryUser.ID);

  // Dedupe TaskRecords on (taskType, taskLegacyId)
  moved.taskRecordsDeduped = await dedupeTaskRecords(TaskRecords, primaryUser.ID);

  // Recompute GROUP/MISSION rollups for the primary from the merged leaf set
  const { rollUpParentsForCompletion } = await import('./completion-rollup.js');
  const db = await cds.connect.to('db');
  const LEAF = ['TUTORIAL', 'STEP', 'PUZZLE', 'CHECKPOINT', 'PETOBERFEST', 'KTT_LESSON'];
  const leaves = await SELECT.from(TaskRecords)
    .where({ user_ID: primaryUser.ID, status: 'COMPLETED', taskType: { in: LEAF } });
  for (const r of leaves) {
    await rollUpParentsForCompletion({
      dbUser: primaryUser,
      task: { taskType: r.taskType, taskLegacyId: r.taskLegacyId },
      db,
    });
  }

  // Track the merge
  let primary = await SELECT.one.from(PrimaryAccounts).where({ uuid: primaryUuid });
  if (!primary) {
    await INSERT.into(PrimaryAccounts).entries({
      uuid: primaryUuid, status: 'ACTIVE', legacyId: primaryUser.legacyId
    });
    primary = await SELECT.one.from(PrimaryAccounts).where({ uuid: primaryUuid });
  }

  await INSERT.into(SecondaryAccounts).entries({
    uuid: secondaryUuid,
    primaryAccount_ID: primary.ID,
    status: 'MERGED',
    mergedAt: new Date().toISOString(),
    legacyId: secondaryUser.legacyId
  });

  LOG.info(`Merge complete: ${secondaryUuid} → ${primaryUuid}`);
  return { primaryUuid, secondaryUuid, status: 'MERGED', movedCounts: moved };
}
