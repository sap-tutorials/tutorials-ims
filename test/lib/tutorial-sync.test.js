import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('tutorial-sync', () => {
  let syncTutorialMetadata;

  beforeAll(async () => {
    ({ syncTutorialMetadata } = await import('../../srv/lib/tutorial-sync.js'));

    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: 'eeeeeeee-0001-0000-0000-000000000001', slug: 'cap-getting-started', title: 'Getting Started with CAP', legacyId: 5001, status: 'ACTIVE' },
      { ID: 'eeeeeeee-0002-0000-0000-000000000001', slug: 'hana-basics', title: 'HANA Basics', legacyId: 5002, status: 'ACTIVE' },
    ]);
  });

  it('creates TutorialMeta records for tutorials without metadata', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');

    const metadataSource = [
      { slug: 'cap-getting-started', owner: 'thomas.jung@sap.com', reviewedDate: '2026-03-15' },
      { slug: 'hana-basics', owner: 'rich.heilman@sap.com', reviewedDate: '2026-02-01' },
    ];

    const result = await syncTutorialMetadata(metadataSource);
    expect(result.synced).toBe(2);

    const meta = await SELECT.from(TutorialMeta);
    expect(meta.length).toBe(2);
  });

  it('updates existing TutorialMeta when sync is re-run', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');

    const metadataSource = [
      { slug: 'cap-getting-started', owner: 'new.owner@sap.com', reviewedDate: '2026-04-01' },
    ];

    await syncTutorialMetadata(metadataSource);
    const meta = await SELECT.from(TutorialMeta)
      .where({ tutorial_ID: 'eeeeeeee-0001-0000-0000-000000000001' });
    expect(meta[0].owner).toBe('new.owner@sap.com');
  });
});
