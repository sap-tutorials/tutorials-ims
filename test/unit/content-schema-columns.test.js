import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('content schema #2802 columns', () => {
  let m;
  beforeAll(async () => { m = await cds.load('db/_content-shape.cds'); });
  const el = (ent) => cds.linked(m).definitions[`com.sap.developers.ims.shared.${ent}`].elements;
  it('ContentFilesAspect has bodyHash', () => expect(el('ContentFilesAspect').bodyHash).toBeDefined());
  it('ContentCurrentAspect has bodyHash', () => expect(el('ContentCurrentAspect').bodyHash).toBeDefined());
  it('ContentHistoryAspect has bodyHash', () => expect(el('ContentHistoryAspect').bodyHash).toBeDefined());
  it('ContentManifestAspect has conceptPhaseToken', () => expect(el('ContentManifestAspect').conceptPhaseToken).toBeDefined());
});
