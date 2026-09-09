// srv/__tests__/lib/catalog-data-smtechids.test.js
import '@sap/cds'; // registers SELECT/CQL globals used by resolveSmTechIds
import { describe, it, expect } from 'vitest';
import { resolveSmTechIds } from '../../lib/catalog-data.js';

// Call-counter fakeDb: first call returns links, second call returns tags.
// More reliable than string-matching the CQN object (whose toString() is
// implementation-defined and may not expose the entity name).
function fakeDb({ links, tags }) {
  let call = 0;
  return {
    run: async () => {
      call++;
      return call === 1 ? links : tags;
    },
  };
}

describe('resolveSmTechIds', () => {
  it("returns semaphoreIds of the owner's product tags", async () => {
    const db = fakeDb({
      links: [{ tag_ID: 't1' }, { tag_ID: 't2' }],
      tags: [
        { ID: 't1', semaphoreId: '111', isActualTag: true },
        { ID: 't2', semaphoreId: null,  isActualTag: true },
      ],
    });
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g1');
    expect(ids).toEqual(['111']);
  });

  it('excludes tags with empty-string semaphoreId', async () => {
    const db = fakeDb({
      links: [{ tag_ID: 't1' }, { tag_ID: 't2' }],
      tags: [
        { ID: 't1', semaphoreId: '222', isActualTag: true },
        { ID: 't2', semaphoreId: '',    isActualTag: true },
      ],
    });
    const ids = await resolveSmTechIds(db, 'MissionTags', 'mission_ID', 'm1');
    expect(ids).toEqual(['222']);
  });

  it('emits every linked tag with a semaphoreId regardless of isActualTag', async () => {
    const db = fakeDb({
      links: [{ tag_ID: 't1' }, { tag_ID: 't2' }],
      tags: [
        { ID: 't1', semaphoreId: '111', isActualTag: true },
        { ID: 't2', semaphoreId: '222', isActualTag: false },
      ],
    });
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g1');
    expect(ids).toEqual(['111', '222']);
  });

  it('returns [] when the owner has no tag links', async () => {
    const db = fakeDb({ links: [], tags: [] });
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g-empty');
    expect(ids).toEqual([]);
  });

  it('returns [] and never throws on a DB error', async () => {
    const db = { run: async () => { throw new Error('boom'); } };
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', 'g1');
    expect(ids).toEqual([]);
  });

  it('returns [] when ownerId is falsy', async () => {
    const db = fakeDb({ links: [], tags: [] });
    const ids = await resolveSmTechIds(db, 'GroupTags', 'group_ID', null);
    expect(ids).toEqual([]);
  });
});
