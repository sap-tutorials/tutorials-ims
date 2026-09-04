// test/admin-channel-collections.test.js
import cds from '@sap/cds';
import { describe, it, expect } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService channel collections', () => {
  it('exposes ChannelCollections as a draft-enabled admin entity', async () => {
    const { AdminService } = cds.services;
    const csn = AdminService.model.definitions['AdminService.ChannelCollections'];
    expect(csn).toBeTruthy();
    expect(csn['@odata.draft.enabled']).toBe(true);
    expect(AdminService.model.definitions['AdminService.ChannelCollectionItems']).toBeTruthy();
  });
});
