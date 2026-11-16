// test/unit/data-privacy-export.test.js
//
// TDD suite for DataPrivacyService.exportDataSubject(userId).
//
// Boots ONLY the DataPrivacyService (cds.serve().from()) rather than the
// full project (cds.test('serve')), so that other srv/*.js files that depend
// on built artifacts (srv/lib/_shared/mcp.bundle.mjs) are not loaded.
// Pattern: admin-last-chance-action.test.js (cds.deploy + cds.serve().from).
//
// Assertions:
//   - envelope.subject carries the 9 @PersonalData.IsPotentiallyPersonal fields
//   - AuthorAiRequests row (authorId=user.sapId, user_ID=null) appears in output
//     (end-to-end proof that the authorId resolver path works)
//   - DeveloperEnvironmentLinks appear nested under their parent Tab
//   - CodeCheckSubmissions.submittedCode (LargeString) round-trips in output
//   - count:0 section for an entity with no rows for this user (not omitted)
//   - AnalyticsQueryHistory (EntitySemantics: 'Other', no DataSubjectID) does
//     NOT appear in sections and does NOT crash
//   - unknown userId -> handler rejects with a 404-shaped error

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { _resetPlanForTest } from '../../srv/lib/anonymization-cascade.js';

// Schema paths -- load schema.cds + audit-logging.cds so @PersonalData
// annotations are present (same pattern as anonymization-cascade.test.js).
const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.cds');
const AUDIT_PATH  = path.join(process.cwd(), 'db', 'audit-logging.cds');
const SVC_PATH    = path.join(process.cwd(), 'srv', 'data-privacy-service.cds');

const ADMIN = { id: 'admin@example.com', roles: ['Admin'] };

// Deterministic UUIDs for reproducible tests.
const USER_ID   = 'aaaaaaaa-1111-1111-1111-111111111111';
const OTHER_ID  = 'bbbbbbbb-2222-2222-2222-222222222222';
const SAP_ID    = 'S00ALICE';
const USER_UUID = 'cccccccc-3333-3333-3333-333333333333';
const TAB_ID    = 'dddddddd-4444-4444-4444-444444444444';
const LINK_ID   = 'eeeeeeee-5555-5555-5555-555555555555';

// Send a function call as the admin user.
async function callExport(srv, userId) {
  const user = new cds.User({ id: ADMIN.id, roles: ADMIN.roles });
  return srv.tx({ user }, (tx) =>
    tx.send('exportDataSubject', { userId })
  );
}

describe('DataPrivacyService.exportDataSubject', () => {
  let srv;

  beforeAll(async () => {
    // Deploy schema + annotations to in-memory SQLite, then serve ONLY
    // DataPrivacyService from its handler file.
    await cds.deploy([SCHEMA_PATH, AUDIT_PATH, SVC_PATH]).to('sqlite::memory:');
    srv = await cds.serve('DataPrivacyService').from('./srv/data-privacy-service');
    // cds.model can be null on Windows with cds.deploy() (ESM singleton divergence).
    // CAP's internal scheduling queue accesses cds.model.definitions at commit time;
    // backfill cds.model from cds.db.model to prevent unhandled rejections.
    if (!cds.model && cds.db?.model) cds.model = cds.db.model;
  });

  beforeEach(async () => {
    _resetPlanForTest();

    // Clear all relevant tables in dependency order (children before parents).
    const {
      DeveloperEnvironmentLinks,
      DeveloperEnvironmentTabs,
      CodeCheckSubmissions,
      ValidateAnswerSubmissions,
      AuthorAiRequests,
      UserMetaData,
      UserLearningPreferences,
      PrizeRecords,
      AccomplishmentRecords,
      Users,
    } = cds.entities('com.sap.developers.ims');

    await DELETE.from(DeveloperEnvironmentLinks);
    await DELETE.from(DeveloperEnvironmentTabs);
    await DELETE.from(CodeCheckSubmissions);
    await DELETE.from(ValidateAnswerSubmissions);
    await DELETE.from(AuthorAiRequests);
    await DELETE.from(UserMetaData);
    await DELETE.from(UserLearningPreferences);
    await DELETE.from(PrizeRecords);
    await DELETE.from(AccomplishmentRecords);
    await DELETE.from(Users);
  });

  // --- Seed helper ---
  async function seedFixtures() {
    const {
      Users,
      UserMetaData,
      CodeCheckSubmissions,
      AuthorAiRequests,
      DeveloperEnvironmentLinks,
      DeveloperEnvironmentTabs,
    } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Users).entries({
      ID:              USER_ID,
      sapId:           SAP_ID,
      uuid:            USER_UUID,
      firstName:       'Alice',
      lastName:        'Smith',
      email:           'alice@example.com',
      displayName:     'Alice Smith',
      khorosId:        'kh-001',
      khorosLogin:     'alice_khoros',
      khorosAvatarUrl: 'https://cdn.example/alice.png',
    });

    // Another user -- her rows must NOT appear in Alice's export.
    await INSERT.into(Users).entries({
      ID: OTHER_ID, sapId: 'S00BOB',
      uuid: 'cccccccc-9999-9999-9999-999999999999',
      firstName: 'Bob', email: 'bob@example.com',
    });

    // UserMetaData -- direct user_ID FK.
    await INSERT.into(UserMetaData).entries({
      ID: 'aabb0001-0000-0000-0000-000000000001',
      user_ID: USER_ID,
    });
    await INSERT.into(UserMetaData).entries({
      ID: 'aabb0001-0000-0000-0000-000000000002',
      user_ID: OTHER_ID,
    });

    // CodeCheckSubmissions -- LargeString round-trip.
    await INSERT.into(CodeCheckSubmissions).entries({
      ID:           'ffffffff-6666-6666-6666-666666666666',
      user_ID:      USER_ID,
      tutorialSlug: 'test-tutorial',
      stepNumber:   1,
      submittedCode: 'console.log("hello world");',
      verdict:      'pass',
    });

    // AuthorAiRequests -- authorId path (user_ID intentionally null).
    await INSERT.into(AuthorAiRequests).entries({
      ID:             '11111111-7777-7777-7777-777777777777',
      authorId:       SAP_ID,
      feature:        'os-variants',
      sourceMarkdown: '# Test markdown',
      variants:       '[{"os":"linux","markdown":"# Test"}]',
      user_ID:        null,
    });

    // DeveloperEnvironmentTabs + Links -- nested output.
    await INSERT.into(DeveloperEnvironmentTabs).entries({
      ID:       TAB_ID,
      user_ID:  USER_ID,
      tabName:  'My Tab',
      tabOrder: 1,
    });
    await INSERT.into(DeveloperEnvironmentLinks).entries({
      ID:        LINK_ID,
      tab_ID:    TAB_ID,
      title:     'SAP Developers',
      url:       'https://developers.sap.com',
      linkOrder: 1,
    });
  }

  // -------------------------------------------------------------------------

  it('returns a valid JSON envelope with subject block containing 9 personal fields', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    expect(doc.exportedAt).toBeTruthy();
    expect(doc.exportedBy).toBe(ADMIN.id);
    expect(Array.isArray(doc.sections)).toBe(true);

    const s = doc.subject;
    expect(s.firstName).toBe('Alice');
    expect(s.lastName).toBe('Smith');
    expect(s.email).toBe('alice@example.com');
    expect(s.displayName).toBe('Alice Smith');
    expect(s.sapId).toBe(SAP_ID);
    expect(s.uuid).toBe(USER_UUID);
    expect(s.khorosId).toBe('kh-001');
    expect(s.khorosLogin).toBe('alice_khoros');
    expect(s.khorosAvatarUrl).toBe('https://cdn.example/alice.png');
  });

  it('AuthorAiRequests row (authorId path, no user_ID FK) appears in sections', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    const section = doc.sections.find((s) => s.entity.includes('AuthorAiRequests'));
    expect(section).toBeTruthy();
    expect(section.count).toBe(1);
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0].sourceMarkdown).toBe('# Test markdown');
  });

  it('DeveloperEnvironmentLinks appear nested under their parent Tab row', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    const tabSection = doc.sections.find(
      (s) => s.entity.includes('DeveloperEnvironmentTabs')
    );
    expect(tabSection).toBeTruthy();
    expect(tabSection.count).toBe(1);

    const tabRow = tabSection.rows.find((r) => r.ID === TAB_ID);
    expect(tabRow).toBeTruthy();
    expect(Array.isArray(tabRow.links)).toBe(true);
    expect(tabRow.links).toHaveLength(1);
    expect(tabRow.links[0].title).toBe('SAP Developers');
    expect(tabRow.links[0].url).toBe('https://developers.sap.com');
  });

  it('CodeCheckSubmissions.submittedCode (LargeString) round-trips through JSON output', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    const section = doc.sections.find(
      (s) => s.entity.includes('CodeCheckSubmissions')
    );
    expect(section).toBeTruthy();
    expect(section.count).toBe(1);
    expect(section.rows[0].submittedCode).toBe('console.log("hello world");');
  });

  it('entity with no rows for the subject has count:0 and empty rows array (not omitted)', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    // ValidateAnswerSubmissions is a @PersonalData entity with user FK,
    // but no rows seeded for Alice -> must appear with count:0.
    const section = doc.sections.find(
      (s) => s.entity.includes('ValidateAnswerSubmissions')
    );
    expect(section).toBeTruthy();
    expect(section.count).toBe(0);
    expect(section.rows).toEqual([]);
  });

  it('AnalyticsQueryHistory does not appear in sections (Other semantics, no DataSubjectID)', async () => {
    await seedFixtures();
    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    const section = doc.sections.find(
      (s) => s.entity.includes('AnalyticsQueryHistory')
    );
    expect(section).toBeUndefined();
  });

  it('unknown userId rejects with a 404-shaped error', async () => {
    const missingId = 'zzzzzzzz-0000-0000-0000-000000000000';
    await expect(
      callExport(srv, missingId)
    ).rejects.toMatchObject({ code: 404 });
  });

  it('AuthorAiRequests rows for another user (different sapId) do not appear', async () => {
    await seedFixtures();
    const { AuthorAiRequests } = cds.entities('com.sap.developers.ims');
    await INSERT.into(AuthorAiRequests).entries({
      ID:             '22222222-8888-8888-8888-888888888888',
      authorId:       'S00BOB',
      feature:        'os-variants',
      sourceMarkdown: 'Bob private data',
      user_ID:        null,
    });

    const raw = await callExport(srv, USER_ID);
    const doc = JSON.parse(raw);

    const section = doc.sections.find(
      (s) => s.entity.includes('AuthorAiRequests')
    );
    expect(section.rows.every((r) => r.authorId === SAP_ID)).toBe(true);
    expect(section.rows.some((r) => r.sourceMarkdown === 'Bob private data')).toBe(false);
  });

  it('_selectRows warns when a declared personalField is not a selectable element', async () => {
    // Seed a UserMetaData row so the SELECT returns at least one row.
    const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: USER_ID, sapId: SAP_ID, uuid: USER_UUID,
      firstName: 'Alice', email: 'alice@example.com',
    });
    await INSERT.into(UserMetaData).entries({
      ID: 'aabb0001-0000-0000-0000-000000000001',
      user_ID: USER_ID,
    });

    // Build a minimal definitions object that represents UserMetaData with a
    // phantom personal field 'nonExistentField'. We do NOT use the real model
    // here -- we want to exercise the warn path in isolation.
    const ENTITY = 'com.sap.developers.ims.UserMetaData';
    const fakeDefs = {
      [ENTITY]: {
        elements: {
          ID:      {},
          user_ID: {},
          // 'nonExistentField' intentionally absent
        }
      }
    };

    // cds.log returns an object whose .warn is a function. Spy on it.
    // The LOG instance inside the module is bound at module load time to the
    // 'data-privacy-service' tag. We obtain a reference by asking cds.log for
    // the same tag -- cds.log caches instances by tag.
    const logger = cds.log('data-privacy-service');
    const warnSpy = vi.spyOn(logger, 'warn');

    // Call _selectRows directly on the service instance.
    const rows = await srv._selectRows(
      ENTITY,
      'user_ID',
      [USER_ID],
      ['nonExistentField'], // declared personal field that does not exist
      fakeDefs
    );

    // warn must have fired mentioning the entity and the missing field.
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0].join(' ');
    expect(warnMsg).toMatch(/nonExistentField/);
    expect(warnMsg).toMatch(/UserMetaData/);

    // The row must still be exported using the real columns that do exist.
    // With fakeDefs (no ID in elements -- wait, ID IS in fakeDefs), user_ID is
    // the only included column from the candidates after filtering.
    // Rows length: 1 (the seeded UserMetaData row).
    expect(rows.length).toBe(1);

    warnSpy.mockRestore();
  });
});
