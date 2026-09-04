import { describe, it, expect } from 'vitest';
import { filterChannels } from './filter';

const data = [
  { name: 'BTP Docs', category: 'Portal', platform: 'Web', isSapOwned: true, purpose: 'docs', tags: ['btp'] },
  { name: 'Reddit SAP', category: 'Community', platform: 'Web', isSapOwned: false, purpose: 'forum', tags: ['community'] },
];

describe('filterChannels', () => {
  it('matches query across name/purpose/tags', () => {
    expect(filterChannels(data, { query: 'reddit' }).map((c) => c.name)).toEqual(['Reddit SAP']);
    expect(filterChannels(data, { query: 'btp' }).map((c) => c.name)).toEqual(['BTP Docs']);
  });
  it('filters by owner scope', () => {
    expect(filterChannels(data, { ownerScope: 'sap' }).map((c) => c.name)).toEqual(['BTP Docs']);
    expect(filterChannels(data, { ownerScope: 'community' }).map((c) => c.name)).toEqual(['Reddit SAP']);
  });
  it('filters by category and platform', () => {
    expect(filterChannels(data, { category: 'Portal' })).toHaveLength(1);
    expect(filterChannels(data, { platform: 'Web' })).toHaveLength(2);
  });
});
