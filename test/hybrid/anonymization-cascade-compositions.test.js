// test/hybrid/anonymization-cascade-compositions.test.js
// #960 — Guards the anonymization cascade behavior change from spec §2a.
// After annotating PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs,
// DeveloperEnvironmentLinks with @PersonalData + cascade: 'delete', running
// executeAnonymizationCascade(user) must delete rows in all four entities
// for that user. Prior to this PR the rows survived as FK-ghosts.
//
// Prerequisite: ALLOW_HYBRID_WRITES=true environment variable must be set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { executeAnonymizationCascade } from '../../srv/lib/anonymization-cascade.js';
import { isSafeForWrites } from '../hybrid/_guard.js'; // ALLOW_HYBRID_WRITES gate

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const TAG = '__TEST__#960-cascade-compositions';

// IDs seeded in beforeAll — held at module scope for afterAll cleanup.
let userId;
let eventId;
let accId;
let prizeRecordId;
let accRecordId;
let tabId;
let linkId;

describe.runIf(isSafeForWrites())('#960 anonymization cascade — 4 Users compositions delete on cascade', () => {

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid write guard: set ALLOW_HYBRID_WRITES=true to run this suite');
    }
    const db = await cds.connect.to('db');

    const {
      Users,
      PrizeRecords,
      AccomplishmentRecords,
      DeveloperEnvironmentTabs,
      DeveloperEnvironmentLinks,
      Events,
      Accomplishments,
    } = cds.entities(NS);

    userId        = cds.utils.uuid();
    eventId       = cds.utils.uuid();
    accId         = cds.utils.uuid();
    prizeRecordId = cds.utils.uuid();
    accRecordId   = cds.utils.uuid();
    tabId         = cds.utils.uuid();
    linkId        = cds.utils.uuid();

    await INSERT.into(Users).entries({
      ID:        userId,
      firstName: `${TAG}-first`,
      lastName:  `${TAG}-last`,
      email:     `${TAG}-${userId.slice(0, 8)}@example.test`,
    });

    // Synthetic Event + Accomplishment for FK targets — no dependency on seed data.
    await INSERT.into(Events).entries({ ID: eventId, name: `${TAG}-evt` });
    await INSERT.into(Accomplishments).entries({ ID: accId, name: `${TAG}-acc` });

    await INSERT.into(PrizeRecords).entries({
      ID:      prizeRecordId,
      user_ID: userId,
      event_ID: eventId,
      // prizeType does not exist on PrizeRecords; use `status` (String(50)).
      status:  `${TAG}-prize`,
    });
    await INSERT.into(AccomplishmentRecords).entries({
      ID:                accRecordId,
      user_ID:           userId,
      accomplishment_ID: accId,
    });
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID:      tabId,
      user_ID: userId,
      tabName: `${TAG}-tab`,
    });
    await INSERT.into(DeveloperEnvironmentLinks).entries({
      ID:     linkId,
      tab_ID: tabId,
      title:  `${TAG}-link`,
      url:    'https://example.test/',
    });
  });

  afterAll(async () => {
    // Best-effort cleanup via tracked IDs.
    // cascade should have already deleted child rows; this catches any remnants.
    const {
      Users,
      PrizeRecords,
      AccomplishmentRecords,
      DeveloperEnvironmentTabs,
      DeveloperEnvironmentLinks,
      Events,
      Accomplishments,
    } = cds.entities(NS);

    if (linkId)        await DELETE.from(DeveloperEnvironmentLinks).where({ ID: linkId });
    if (tabId)         await DELETE.from(DeveloperEnvironmentTabs).where({ ID: tabId });
    if (accRecordId)   await DELETE.from(AccomplishmentRecords).where({ ID: accRecordId });
    if (prizeRecordId) await DELETE.from(PrizeRecords).where({ ID: prizeRecordId });
    if (userId)        await DELETE.from(Users).where({ ID: userId });
    if (accId)         await DELETE.from(Accomplishments).where({ ID: accId });
    if (eventId)       await DELETE.from(Events).where({ ID: eventId });
  });

  it('deletes rows in all 4 composition entities on cascade', async () => {
    const db = await cds.connect.to('db');
    const {
      PrizeRecords,
      AccomplishmentRecords,
      DeveloperEnvironmentTabs,
      DeveloperEnvironmentLinks,
    } = cds.entities(NS);

    // Sanity: rows exist before cascade.
    expect((await SELECT.from(PrizeRecords).where({ user_ID: userId })).length).toBe(1);
    expect((await SELECT.from(AccomplishmentRecords).where({ user_ID: userId })).length).toBe(1);
    expect((await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: userId })).length).toBe(1);
    expect((await SELECT.from(DeveloperEnvironmentLinks).where({ ID: linkId })).length).toBe(1);

    // executeAnonymizationCascade takes a user object (not a bare UUID string)
    // and a db handle so the cascade walker can resolve cds.model.
    await executeAnonymizationCascade({ ID: userId }, db);

    // PrizeRecords, AccomplishmentRecords, DeveloperEnvironmentTabs — deleted
    // directly by the cascade walker's cascadeDelete() because each entity has
    // @PersonalData.FieldSemantics: 'DataSubjectID' on its `user` association.
    expect((await SELECT.from(PrizeRecords).where({ user_ID: userId })).length).toBe(0);
    expect((await SELECT.from(AccomplishmentRecords).where({ user_ID: userId })).length).toBe(0);
    expect((await SELECT.from(DeveloperEnvironmentTabs).where({ user_ID: userId })).length).toBe(0);

    // DeveloperEnvironmentLinks are annotated with `tab` as DataSubjectID (tab is
    // an Association to DeveloperEnvironmentTabs, not to Users). The direct cascade
    // walk would execute DELETE WHERE tab_ID = userId — which deletes 0 rows (wrong
    // FK target). The links are actually removed by the CDS Composition cascade when
    // the parent DeveloperEnvironmentTabs rows are deleted above. We query by the
    // known tab_ID rather than a navigation to avoid an unsupported JOIN predicate.
    expect((await SELECT.from(DeveloperEnvironmentLinks).where({ tab_ID: tabId })).length).toBe(0);
  });
});
