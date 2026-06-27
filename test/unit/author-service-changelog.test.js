// test/unit/author-service-changelog.test.js
//
// Task 8 (#617) — AuthorService.TutorialChanges read-only surface.
// Projects ims.AuthorTutorialChanges (db/views.cds), a view that filters
// sap.changelog.Changes to entity = 'AdminService.Tutorials'. Verifies the
// filter actually scopes results to Tutorials-only when Missions rows also
// exist in the changelog.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AuthorService.TutorialChanges', () => {
  beforeAll(async () => {
    // Seed both Tutorials and Missions change rows so the filter has
    // something to discriminate against.
    const Changes = cds.entities('sap.changelog').Changes;
    await INSERT.into(Changes).entries([
      {
        ID: cds.utils.uuid(),
        entity: 'AdminService.Tutorials',
        entityKey: 't1',
        attribute: 'title',
        valueChangedFrom: 'A',
        valueChangedTo: 'B',
      },
      {
        ID: cds.utils.uuid(),
        entity: 'AdminService.Missions',
        entityKey: 'm1',
        attribute: 'title',
        valueChangedFrom: 'C',
        valueChangedTo: 'D',
      },
    ]);
  });

  it('returns only Tutorials change rows (Missions filtered out)', async () => {
    const { GET } = project;
    const res = await GET('/author/TutorialChanges?$top=50', {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
    const rows = res.data.value ?? res.data;
    const entities = new Set(rows.map((r) => r.entity));
    expect(entities.has('AdminService.Tutorials')).toBe(true);
    expect(entities.has('AdminService.Missions')).toBe(false);
  });
});
