import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql annotation shape', () => {
  let csn;
  beforeAll(async () => {
    csn = await cds.load(['srv/search-service.cds']);
  });

  it('SearchService carries @graphql', () => {
    const svc = csn.definitions['SearchService'];
    expect(svc?.['@graphql']).toBe(true);
  });
});
