import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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
    vi.restoreAllMocks();
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

  // CRITICAL guard: user with sapId=null AND uuid=null must not throw (empty IN list)
  it('test_cascade_no_throw_when_authorId_candidates_empty', async () => {
    const { Users, AuthorAiRequests } = cds.entities('com.sap.developers.ims');

    // A legacy/partially-anonymized user with both sapId and uuid null.
    // authorIdCandidates(user) returns [] — without the empty-array guard
    // the cascade would emit WHERE authorId IN () which is a SQL syntax error
    // on HANA, aborting the whole erasure run.
    const userId = '33333333-3333-3333-3333-333333333333';
    await INSERT.into(Users).entries({
      ID: userId,
      sapId: null,
      uuid: null,
      firstName: 'Legacy',
      email: 'legacy@example.com'
    });

    // Seed an AuthorAiRequests row — it should survive (no key to match)
    // but the cascade must not throw.
    const reqId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await INSERT.into(AuthorAiRequests).entries({
      ID: reqId,
      authorId: 'some-old-id',
      feature: 'os-variants',
      sourceMarkdown: 'legacy content',
      user_ID: null
    });

    // Spy on LOG to verify the warn fires for the unmatched entity.
    // The module uses cds.log('anonymization-cascade'); we intercept warn
    // on the active logger instance. Use cds.log as a factory to get the
    // same logger instance the module holds.
    const logger = cds.log('anonymization-cascade');
    const warnSpy = vi.spyOn(logger, 'warn');

    // Must not throw — the empty-candidates guard skips instead of
    // issuing WHERE authorId IN () which is a HANA syntax error.
    await expect(
      executeAnonymizationCascade(
        { ID: userId, sapId: null, uuid: null },
        await cds.connect.to('db')
      )
    ).resolves.toBeUndefined();

    // The LOG.warn for the empty-candidates skip must have fired.
    const warnCalls = warnSpy.mock.calls.map(c => c[0]);
    const emptyGuardFired = warnCalls.some(
      msg => typeof msg === 'string' && msg.includes('no data-subject candidates')
    );
    expect(emptyGuardFired).toBe(true);

    // Row survives — no key to match; flagged for manual GDPR review via LOG.warn.
    const rows = await SELECT.from(AuthorAiRequests).where({ ID: reqId });
    expect(rows).toHaveLength(1);
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

    // A Link nested under the Tab.
    // The cascade must delete this via the nested-marker path:
    //   1. SELECT DeveloperEnvironmentTabs WHERE user_ID = userId  -> [tabId]
    //   2. DELETE DeveloperEnvironmentLinks WHERE tab_ID IN [tabId]
    //
    // DeveloperEnvironmentTabs runs at plan index 3 and DeveloperEnvironmentLinks
    // at index 4 (stable sort, both cascade:'delete'), so the Tabs step also
    // deletes the Link via Composition. The spy below independently verifies
    // the nested-marker branch issued its own DELETE, isolating the code path.
    const linkId = 'llllllll-llll-llll-llll-llllllllllll';
    await INSERT.into(DeveloperEnvironmentLinks).entries({
      ID: linkId,
      tab_ID: tabId,
      legacyId: 10
    });

    // Manual spy on cds.db.run using an own-property override so that the deep
    // prototype method (DatabaseService.run at depth 3) is intercepted.
    // vi.spyOn cannot reliably wrap a method that far up the prototype chain,
    // so we use Object.defineProperty on the instance directly.
    // This captures every CQL query dispatched through the connected DB service.
    const capturedRuns = [];
    const origRun = cds.db.run.bind(cds.db);
    Object.defineProperty(cds.db, 'run', {
      value: async function (q, ...args) {
        try {
          const s = JSON.stringify(q);
          if (s) capturedRuns.push(s);
        } catch { /* non-serializable query; skip */ }
        return origRun(q, ...args);
      },
      writable: true,
      configurable: true
    });

    try {
      await executeAnonymizationCascade(
        { ID: userId, sapId: sapId },
        await cds.connect.to('db')
      );
    } finally {
      // Always remove the own-property override so prototype is restored.
      delete cds.db.run;
    }

    // Verify the nested-marker branch in cascadeDelete fired correctly:
    // it must have issued a SELECT on DeveloperEnvironmentTabs (the `via` entity)
    // with WHERE user_ID = userId to resolve the parent IDs before deciding
    // whether to delete child Links.
    //
    // If the nested branch were removed entirely, the resolved.nested check
    // would be skipped; with resolved.values = null the empty-array guard
    // (`!resolved.values?.length`) fires and LOG.warn is emitted — the DELETE
    // never runs AND this intermediate SELECT never runs either.
    // If `resolved.via` were changed to a wrong entity, a different SELECT
    // would appear instead — both cases cause this assertion to fail.
    const nestedSelectFired = capturedRuns.some(
      s => s.includes('"DeveloperEnvironmentTabs"') && s.includes('user_ID') && s.includes(userId)
    );
    expect(nestedSelectFired).toBe(true);

    // Belt-and-braces: the Link must be gone from DB.
    const links = await SELECT.from(DeveloperEnvironmentLinks).where({ ID: linkId });
    expect(links).toHaveLength(0);
  });
});
