import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('account-merge', () => {
  let mergeAccounts;

  beforeAll(async () => {
    ({ mergeAccounts } = await import('../../srv/lib/account-merge.js'));

    const { Users, TaskRecords, PrizeRecords } = cds.entities('com.sap.developers.ims');

    // Primary user
    await INSERT.into(Users).entries({
      ID: 'aaaaaaaa-1111-1111-1111-111111111111',
      uuid: 'primary-uuid', legacyId: 9001, firstName: 'Primary'
    });
    // Secondary user
    await INSERT.into(Users).entries({
      ID: 'bbbbbbbb-2222-2222-2222-222222222222',
      uuid: 'secondary-uuid', legacyId: 9002, firstName: 'Secondary'
    });
    // Task records for secondary
    await INSERT.into(TaskRecords).entries([
      { ID: 'cccccccc-0001-0000-0000-000000000001', user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', taskLegacyId: 100, taskType: 'TUTORIAL', status: 'COMPLETED', legacyId: 8001 },
      { ID: 'cccccccc-0002-0000-0000-000000000001', user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', taskLegacyId: 200, taskType: 'MISSION', status: 'COMPLETED', legacyId: 8002 },
    ]);
    // Prize record for secondary
    await INSERT.into(PrizeRecords).entries({
      ID: 'dddddddd-0001-0000-0000-000000000001',
      user_ID: 'bbbbbbbb-2222-2222-2222-222222222222', legacyId: 7001, status: 'AWARDED'
    });
  });

  it('transfers task records from secondary to primary', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await mergeAccounts('primary-uuid', 'secondary-uuid');

    const primaryRecords = await SELECT.from(TaskRecords)
      .where({ user_ID: 'aaaaaaaa-1111-1111-1111-111111111111' });
    expect(primaryRecords.length).toBe(2);
  });

  it('transfers prize records from secondary to primary', async () => {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    const primaryPrizes = await SELECT.from(PrizeRecords)
      .where({ user_ID: 'aaaaaaaa-1111-1111-1111-111111111111' });
    expect(primaryPrizes.length).toBe(1);
  });

  it('creates tracking records in PrimaryAccounts and SecondaryAccounts', async () => {
    const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
    const primary = await SELECT.one.from(PrimaryAccounts).where({ uuid: 'primary-uuid' });
    expect(primary).toBeTruthy();
    expect(primary.status).toBe('ACTIVE');

    const secondary = await SELECT.one.from(SecondaryAccounts).where({ uuid: 'secondary-uuid' });
    expect(secondary).toBeTruthy();
    expect(secondary.status).toBe('MERGED');
  });
});
