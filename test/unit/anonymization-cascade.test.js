import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { getCascadePlan, _resetPlanForTest, executeAnonymizationCascade } from '../../srv/lib/anonymization-cascade.js';

beforeEach(() => {
  _resetPlanForTest();
  vi.restoreAllMocks();
});

// Helper: synthetic CSN definitions for testing
function makeDef(name, opts) {
  return {
    name,
    kind: 'entity',
    '@PersonalData': opts.personalData,
    elements: opts.elements
  };
}

describe('getCascadePlan', () => {
  it('builds plan entry for an entity with identity-replace cascade', () => {
    const defs = {
      'ims.Users': makeDef('ims.Users', {
        personalData: { EntitySemantics: 'DataSubject', cascade: 'identity-replace' },
        elements: {
          ID:        { '@PersonalData.FieldSemantics': 'DataSubjectID', key: true },
          firstName: { '@PersonalData.IsPotentiallyPersonal': true },
          email:     { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      entityName: 'ims.Users',
      action: 'identity-replace',
      dataSubjectField: 'ID',
      personalFields: ['firstName', 'email']
    });
  });

  it('resolves association FK to <fieldName>_ID', () => {
    const defs = {
      'ims.CodeCheckSubmissions': makeDef('ims.CodeCheckSubmissions', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          user:          { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' },
          submittedCode: { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].dataSubjectField).toBe('user_ID');  // resolved from association
  });

  it('defaults to null-personal when cascade is absent', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('null-personal');
  });

  it('warns and emits action: skip for unknown cascade value', () => {
    const defs = {
      'ims.Bad': makeDef('ims.Bad', {
        personalData: { EntitySemantics: 'Other', cascade: 'totally-made-up' },
        elements: {
          user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('skip');
  });

  it('warns and emits action: skip for entity with no DataSubjectID field', () => {
    const defs = {
      'ims.NoFK': makeDef('ims.NoFK', {
        personalData: { EntitySemantics: 'Other' },
        elements: {
          createdBy: { '@PersonalData.IsPotentiallyPersonal': true }
        }
      })
    };
    const plan = getCascadePlan(defs);
    expect(plan[0].action).toBe('skip');
  });

  it('skips entities with no @PersonalData annotation', () => {
    const defs = {
      'ims.Plain': { kind: 'entity', name: 'ims.Plain', elements: { ID: { key: true } } }
    };
    expect(getCascadePlan(defs)).toEqual([]);
  });

  it('caches: second call returns same array reference', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: { user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' } }
      })
    };
    const first = getCascadePlan(defs);
    const second = getCascadePlan(defs);
    expect(second).toBe(first);
  });

  it('_resetPlanForTest forces re-computation', () => {
    const defs = {
      'ims.Foo': makeDef('ims.Foo', {
        personalData: { EntitySemantics: 'Other' },
        elements: { user: { '@PersonalData.FieldSemantics': 'DataSubjectID', type: 'cds.Association', target: 'ims.Users' } }
      })
    };
    const first = getCascadePlan(defs);
    _resetPlanForTest();
    const second = getCascadePlan(defs);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('cascade action helpers (in-memory SQLite)', () => {
  beforeAll(async () => {
    // Load schema.cds + audit-logging.cds so @PersonalData annotations are present
    // in cds.db.model.definitions (plain schema.cds omits the annotate directives).
    await cds.deploy([
      path.join(process.cwd(), 'db', 'schema.cds'),
      path.join(process.cwd(), 'db', 'audit-logging.cds')
    ]).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { Users, UserMetaData, TaskRecords, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CodeCheckSubmissions);
    await DELETE.from(TaskRecords);
    await DELETE.from(UserMetaData);
    await DELETE.from(Users);
    _resetPlanForTest();
  });

  it('cascadeNullPersonal: nulls FK + IsPotentiallyPersonal fields, keeps row', async () => {
    const { Users, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1',
      firstName: 'Alice', email: 'alice@example.com'
    });
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      user_ID: '11111111-1111-1111-1111-111111111111',
      tutorialSlug: 'sample', stepNumber: 1,
      submittedCode: 'console.log(1)', verdict: 'pass'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);                    // row preserved
    expect(rows[0].user_ID).toBeNull();              // FK nulled
    expect(rows[0].submittedCode).toBeNull();        // IsPotentiallyPersonal field nulled
    expect(rows[0].verdict).toBe('pass');            // analytical column intact
  });

  it('cascadeDelete: removes UserMetaData rows for the user', async () => {
    const { Users, UserMetaData } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1', firstName: 'Alice' },
      { ID: '22222222-2222-2222-2222-222222222222', sapId: 'u2', firstName: 'Bob' }
    ]);
    await INSERT.into(UserMetaData).entries([
      { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_ID: '11111111-1111-1111-1111-111111111111' },
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: '22222222-2222-2222-2222-222222222222' }
    ]);

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(UserMetaData);
    expect(rows).toHaveLength(1);                                                         // u2 row preserved
    expect(rows[0].user_ID).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('cascadeAuditOnly: sets TaskRecords createdBy/modifiedBy to ANONYMIZED, keeps row + FK', async () => {
    const { Users, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1', firstName: 'Alice' });
    await INSERT.into(TaskRecords).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      user_ID: '11111111-1111-1111-1111-111111111111',
      titleSnapshot: 't1', taskType: 'TUTORIAL',
      createdBy: 'alice@example.com', modifiedBy: 'alice@example.com'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const rows = await SELECT.from(TaskRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_ID).toBe('11111111-1111-1111-1111-111111111111');  // FK preserved
    expect(rows[0].createdBy).toBe('ANONYMIZED');
    expect(rows[0].modifiedBy).toBe('ANONYMIZED');
    expect(rows[0].titleSnapshot).toBe('t1');                               // content untouched
  });

  it('cascadeIdentityReplace: applies buildAnonymizationOps shape to Users', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: '11111111-1111-1111-1111-111111111111',
      sapId: 'u1', firstName: 'Alice', lastName: 'Smith',
      email: 'alice@example.com', displayName: 'Alice', avatarUrl: 'https://...'
    });

    await executeAnonymizationCascade(
      { ID: '11111111-1111-1111-1111-111111111111', sapId: 'u1' },
      await cds.connect.to('db')
    );

    const u = await SELECT.one.from(Users).where({ ID: '11111111-1111-1111-1111-111111111111' });
    expect(u.sapId).toBeNull();
    expect(u.firstName).toBe('ANONYMIZED');
    expect(u.lastName).toBe('ANONYMIZED');
    expect(u.email).toBeNull();
    expect(u.displayName).toBe('ANONYMIZED');
    expect(u.avatarUrl).toBeNull();
  });

  it('orchestrator end-to-end: dispatches all four cascade actions in order', async () => {
    const { Users, UserMetaData, TaskRecords, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const userId = '11111111-1111-1111-1111-111111111111';
    await INSERT.into(Users).entries({ ID: userId, sapId: 'u1', firstName: 'Alice', email: 'a@e.com' });
    await INSERT.into(UserMetaData).entries({ ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_ID: userId });
    await INSERT.into(TaskRecords).entries({ ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: userId, titleSnapshot: 't1', taskType: 'TUTORIAL', createdBy: 'a@e.com', modifiedBy: 'a@e.com' });
    await INSERT.into(CodeCheckSubmissions).entries({ ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', user_ID: userId, tutorialSlug: 'sample', stepNumber: 1, submittedCode: 'x', verdict: 'pass' });

    await executeAnonymizationCascade({ ID: userId, sapId: 'u1' }, await cds.connect.to('db'));

    expect(await SELECT.from(UserMetaData)).toHaveLength(0);                                    // deleted
    const tr = await SELECT.from(TaskRecords);
    expect(tr[0].createdBy).toBe('ANONYMIZED');                                                  // audit-only
    const cc = await SELECT.from(CodeCheckSubmissions);
    expect(cc[0].user_ID).toBeNull();
    expect(cc[0].submittedCode).toBeNull();                                                      // null-personal
    const u = await SELECT.one.from(Users).where({ ID: userId });
    expect(u.firstName).toBe('ANONYMIZED');                                                      // identity-replace
  });
});
