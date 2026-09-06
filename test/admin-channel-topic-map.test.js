import cds from '@sap/cds';
import { describe, it, expect } from 'vitest';

cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService.ChannelTopicMap projection', () => {
  it('is exposed and draft-enabled', () => {
    const def = cds.services.AdminService.model.definitions['AdminService.ChannelTopicMap'];
    expect(def).toBeDefined();
    expect(def['@odata.draft.enabled']).toBe(true);
  });
});
