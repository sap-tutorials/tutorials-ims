import cds from '@sap/cds';

export async function mergeAccounts(primaryUuid, secondaryUuid) {
  const { Users, TaskRecords, PrizeRecords, AccomplishmentRecords,
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
