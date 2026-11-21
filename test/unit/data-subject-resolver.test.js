// test/unit/data-subject-resolver.test.js
//
// Pure unit tests for srv/lib/data-subject-resolver.js.
// No CDS boot needed — the resolver is a pure function module.
// planEntry objects are constructed as plain literals (same shape as getCascadePlan output).

import { describe, it, expect } from 'vitest';
import { authorIdCandidates, resolveSubjectKeys } from '../../srv/lib/data-subject-resolver.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = {
  ID:     'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb',
  sapId:  'S00ALICE',
  uuid:   'U-ALICE-1'
};

const USER_NO_UUID = {
  ID:    'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb',
  sapId: 'S00ALICE',
  uuid:  null
};

const USER_NO_SAPID = {
  ID:   'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb',
  sapId: null,
  uuid: 'U-ALICE-1'
};

// Plan-entry factory (mirrors getCascadePlan output shape)
function entry(entityName, dataSubjectField, action = 'delete') {
  return { entityName, action, dataSubjectField, personalFields: [] };
}

// ─── authorIdCandidates ───────────────────────────────────────────────────────

describe('authorIdCandidates', () => {
  it('returns [sapId, uuid] for a user with both', () => {
    expect(authorIdCandidates(USER)).toEqual(['S00ALICE', 'U-ALICE-1']);
  });

  it('filters out null uuid', () => {
    expect(authorIdCandidates(USER_NO_UUID)).toEqual(['S00ALICE']);
  });

  it('filters out null sapId', () => {
    expect(authorIdCandidates(USER_NO_SAPID)).toEqual(['U-ALICE-1']);
  });

  it('returns empty array when both are null', () => {
    expect(authorIdCandidates({ ID: 'x', sapId: null, uuid: null })).toEqual([]);
  });
});

// ─── resolveSubjectKeys ───────────────────────────────────────────────────────

describe('resolveSubjectKeys', () => {
  // (a) Users → { column:'ID', values:[user.ID] }
  it('(a) Users entity → column ID, values [user.ID]', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.Users', 'ID', 'identity-replace'));
    expect(result).toEqual({ column: 'ID', values: [USER.ID] });
  });

  // Also handles plain dataSubjectField === 'ID' regardless of entityName
  it('(a-2) dataSubjectField===ID (any entity) → column ID, values [user.ID]', async () => {
    const result = await resolveSubjectKeys(USER, entry('com.sap.developers.ims.Users', 'ID', 'identity-replace'));
    expect(result).toEqual({ column: 'ID', values: [USER.ID] });
  });

  // (b) user_ID entity (e.g. UserMetaData) → { column:'user_ID', values:[user.ID] }
  it('(b) UserMetaData entry → column user_ID, values [user.ID]', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.UserMetaData', 'user_ID'));
    expect(result).toEqual({ column: 'user_ID', values: [USER.ID] });
  });

  // (c) AuthorAiRequests → column authorId, values contain both sapId and uuid
  it('(c) AuthorAiRequests → column authorId, values contain sapId and uuid', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.AuthorAiRequests', 'authorId'));
    expect(result).not.toBeNull();
    expect(result.column).toBe('authorId');
    expect(result.values).toContain('S00ALICE');
    expect(result.values).toContain('U-ALICE-1');
  });

  it('(c-2) AuthorAiRequests user with only sapId → values=[sapId]', async () => {
    const result = await resolveSubjectKeys(USER_NO_UUID, entry('ims.AuthorAiRequests', 'authorId'));
    expect(result.values).toEqual(['S00ALICE']);
  });

  // (d) skip action or null dataSubjectField → null
  it('(d) action===skip → null', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.AnalyticsQueryHistory', null, 'skip'));
    expect(result).toBeNull();
  });

  it('(d-2) dataSubjectField===null → null', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.Foo', null, 'delete'));
    expect(result).toBeNull();
  });

  it('(d-3) dataSubjectField===false-y empty string → null', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.Foo', '', 'delete'));
    expect(result).toBeNull();
  });

  // (e) DeveloperEnvironmentLinks → nested marker
  it('(e) DeveloperEnvironmentLinks (tab_ID) → nested marker { column, nested, via }', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.DeveloperEnvironmentLinks', 'tab_ID'));
    expect(result).not.toBeNull();
    expect(result.column).toBe('tab_ID');
    expect(result.nested).toBe(true);
    expect(result.via).toBe('com.sap.developers.ims.DeveloperEnvironmentTabs');
    // values should be null (caller must resolve the parent Tabs first)
    expect(result.values).toBeNull();
  });

  // default branch: any *_ID field not specifically handled → { column, values:[user.ID] }
  it('default: arbitrary _ID FK field → column=field, values=[user.ID]', async () => {
    const result = await resolveSubjectKeys(USER, entry('ims.TutorialProgress', 'user_ID'));
    expect(result).toEqual({ column: 'user_ID', values: [USER.ID] });
  });
});
