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

  it('test_cascade_misses_authorId_keyed_rows_today', async () => {
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
    // This represents the gap: cascade identifies the user by Users.ID (UUID),
    // but AuthorAiRequests.authorId is keyed to XSUAA id (a String), so the
    // match will fail and the row will survive.
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

    // Assert: the AuthorAiRequests row STILL EXISTS (documents the gap).
    // Because the cascade looked for rows with user_ID matching the UUID
    // (or resolved association FK), it never matched the authorId scalar field.
    const rows = await SELECT.from(AuthorAiRequests).where({ ID: reqId });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceMarkdown).toBe('secret content that should be anonymized');
  });
});
