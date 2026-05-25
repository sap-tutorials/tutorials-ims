import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

describe('TutorialMeta schema', () => {
  let TutorialMeta;

  beforeAll(async () => {
    const model = await cds.load(schemaPath);
    const linked = cds.linked(model);
    TutorialMeta = linked.definitions['com.sap.developers.ims.TutorialMeta'];
  });

  it('exposes ownerEmail column on TutorialMeta', async () => {
    expect(TutorialMeta.elements.ownerEmail).toBeDefined();
    expect(TutorialMeta.elements.ownerEmail.type).toBe('cds.String');
  });

  it('TutorialMeta is managed (has modifiedAt)', async () => {
    expect(TutorialMeta.elements.modifiedAt).toBeDefined();
    expect(TutorialMeta.elements.createdBy).toBeDefined();
  });
});
