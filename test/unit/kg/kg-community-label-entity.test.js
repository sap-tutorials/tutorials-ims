import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

describe('KgCommunityLabel entity', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(path.join(process.cwd(), 'db'));
  });

  it('is defined with communityFingerprint as the sole key', () => {
    const e = model.definitions['com.sap.developers.ims.KgCommunityLabel'];
    expect(e).toBeTruthy();
    expect(e.kind).toBe('entity');
    const keys = Object.entries(e.elements).filter(([, el]) => el.key).map(([n]) => n);
    expect(keys).toEqual(['communityFingerprint']);
    expect(e.elements.communityFingerprint.length).toBe(64);
    expect(e.elements.label.length).toBe(120);
    expect(e.elements.memberSlugsHash.length).toBe(64);
  });
});
