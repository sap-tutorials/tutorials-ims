import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCascadePlan, _resetPlanForTest } from '../../srv/lib/anonymization-cascade.js';

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
