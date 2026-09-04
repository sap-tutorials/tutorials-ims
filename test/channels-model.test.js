// test/channels-model.test.js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Channels entity', () => {
  const NS = 'com.sap.developers.ims';
  const linked = () => cds.linked(cds.model).entities(NS);

  afterAll(async () => {
    const { Channels } = linked();
    await DELETE.from(Channels).where({ sourceId: 'test-001' });
  });

  it('round-trips array columns', async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries({
      ID: cds.utils.uuid(), sourceId: 'test-001', name: 'Test', url: 'https://x.test',
      focusAreas: ['abap', 'cap'], tags: ['t1'], relatedUrls: ['https://y.test'],
      isSapOwned: true, isPublished: true,
    });
    const row = await SELECT.one.from(Channels).where({ sourceId: 'test-001' });
    expect(row.focusAreas).toEqual(['abap', 'cap']);
    expect(row.tags).toEqual(['t1']);
    expect(row.isPublished).toBe(true);
  });
});
