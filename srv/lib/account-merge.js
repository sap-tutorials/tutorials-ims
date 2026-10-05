import cds from '@sap/cds';

export async function mergeAccounts(primaryUuid, secondaryUuid) {
  const { Users, TaskRecords, PrizeRecords, AccomplishmentRecords,
          UserIdentities, EventRegistrations, CatGameAwards,
          PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('account-merge');

  const primaryUser = await SELECT.one.from(Users).where({ uuid: primaryUuid });
  const secondaryUser = await SELECT.one.from(Users).where({ uuid: secondaryUuid });

  if (!primaryUser) throw new Error(`Primary user not found: ${primaryUuid}`);
  if (!secondaryUser) throw new Error(`Secondary user not found: ${secondaryUuid}`);

  LOG.info(`Merging ${secondaryUuid} → ${primaryUuid}`);

  // Transfer task records
  await UPDATE(TaskRecords)
    .where({ user_ID: secondaryUser.ID })
    .set({ user_ID: primaryUser.ID });

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
  return { primaryUuid, secondaryUuid, status: 'MERGED' };
}
