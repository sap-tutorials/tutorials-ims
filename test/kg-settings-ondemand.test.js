import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { resolveKnowledgeGraphSettings, _resetCacheForTests } from '../srv/lib/runtime-config/kg-settings.js';

describe('resolveKnowledgeGraphSettings — onDemandExtractionEnabled (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(() => {
    _resetCacheForTests();
    delete process.env.KG_ONDEMAND_ENABLED;
  });

  afterEach(() => {
    delete process.env.KG_ONDEMAND_ENABLED;
  });

  it('defaults onDemandExtractionEnabled to false when no row + no env', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(false);
  });

  it('reads onDemandExtractionEnabled=true from the DB row', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    await INSERT.into(KnowledgeGraphSettings).entries({ onDemandExtractionEnabled: true });
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(true);
  });

  it('falls back to env when DB row is empty', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    process.env.KG_ONDEMAND_ENABLED = 'true';
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(true);
  });
});
