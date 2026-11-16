import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { _resetPlanForTest, executeAnonymizationCascade } from '../../srv/lib/anonymization-cascade.js';

describe('anonymization-cascade: AuthorAiRequests authorId gap', () => {
  beforeAll(async () => {
    // Load schema.cds + audit-logging.cds so @PersonalData annotations are present
    // in cds.db.model.definitions (plain schema.cds omits the annotate directives).
    await cds.deploy([
      path.join(process.cwd(), 'db', 'schema.cds'),
      path.join(process.cwd(), 'db', 'audit-logging.cds')
    ]).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { Users, AuthorAiRequests } = cds.entities('com.sap.developers.ims');
    await DELETE.from(AuthorAiRequests);
    await DELETE.from(Users);
    _resetPlanForTest();
  });

  it('test_cascade_deletes_authorId_keyed_rows', async () => {
    const { Users, AuthorAiRequests } = cds.entities('com.sap.developers.ims');

    // Seed a Users row with ID (UUID) and sapId (XSUAA id)
    const userId = '11111111-1111-1111-1111-111111111111';
    const sapId = 'S00ALICE';
    await INSERT.into(Users).entries({
      ID: userId,
      sapId: sapId,
      firstName: 'Alice',
      email: 'alice@example.com'
    });

    // Seed an AuthorAiRequests row with authorId (XSUAA id, same as sapId),
    // sourceMarkdown content, and NO user_ID FK (null).
    // The cascade must resolve authorId -> sapId and delete the row.
    const reqId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await INSERT.into(AuthorAiRequests).entries({
      ID: reqId,
      authorId: sapId,  // XSUAA id, NOT the UUID
      feature: 'os-variants',
      sourceMarkdown: 'secret content that should be anonymized',
      user_ID: null     // no FK to Users
    });

    // Run cascade for the user
    await executeAnonymizationCascade(
      { ID: userId, sapId: sapId },
      await cds.connect.to('db')
    );

    // Assert: the AuthorAiRequests row is DELETED (gap is closed).
    // The resolver maps authorId -> sapId candidates and the cascade
    // deletes rows WHERE authorId IN [sapId, uuid].
    const rows = await SELECT.from(AuthorAiRequests).where({ ID: reqId });
    expect(rows).toHaveLength(0);
  });

  it('test_cascade_deletes_tab_nested_DeveloperEnvironmentLinks', async () => {
    const {
      Users,
      DeveloperEnvironmentTabs,
      DeveloperEnvironmentLinks
    } = cds.entities('com.sap.developers.ims');

    // Clean up before this test case (beforeEach only cleans AuthorAiRequests/Users)
    await DELETE.from(DeveloperEnvironmentLinks);
    await DELETE.from(DeveloperEnvironmentTabs);

    const userId = '22222222-2222-2222-2222-222222222222';
    const sapId = 'S00BOB';
    await INSERT.into(Users).entries({
      ID: userId,
      sapId: sapId,
      firstName: 'Bob',
      email: 'bob@example.com'
    });

    // A Tab owned by the user
    const tabId = 'tttttttt-tttt-tttt-tttt-tttttttttttt';
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID: tabId,
      user_ID: userId,
      legacyId: 1
    });

    // A Link nested under the Tab
    const linkId = 'llllllll-llll-llll-llll-llllllllllll';
    await INSERT.into(DeveloperEnvironmentLinks).entries({
      ID: linkId,
      tab_ID: tabId,
      legacyId: 10
    });

    // Run cascade for the user
    await executeAnonymizationCascade(
      { ID: userId, sapId: sapId },
      await cds.connect.to('db')
    );

    // Assert: both the Tab and the Link are deleted
    const tabs = await SELECT.from(DeveloperEnvironmentTabs).where({ ID: tabId });
    const links = await SELECT.from(DeveloperEnvironmentLinks).where({ ID: linkId });
    expect(tabs).toHaveLength(0);
    expect(links).toHaveLength(0);
  });
});
