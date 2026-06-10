import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';
const SLUG = '__test__-branched';

describe('/api/branches/decide', () => {
  beforeAll(async () => {
    const { BranchSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(BranchSpecs).entries({
      slug: SLUG,
      branchPoints: JSON.stringify([{
        id: '1-deployment',
        parentStepNumber: 1,
        groupKey: 'deployment',
        branches: [
          { key: 'hana',     label: 'HANA Cloud', condition: "profile.deployment == 'cloud'", embeddingHint: 'Configure HANA' },
          { key: 'postgres', label: 'PostgreSQL', condition: null, embeddingHint: 'Configure PostgreSQL' },
        ],
      }]),
      skipPoints: JSON.stringify([
        { stepNumber: 4, skipIf: "completed:__test__-prereq", skipLabel: "Skip", skipReason: "You have it" },
      ]),
    });
  });

  afterAll(async () => {
    const { BranchSpecs, ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(BranchSpecs).where({ slug: SLUG });
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it('returns branchPoints + skipPoints when flag-on, anonymous', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const { status, data } = await project.get(`/api/branches/decide?slug=${SLUG}&nocache=1`);
    expect(status).toBe(200);
    expect(data.branchPoints).toHaveLength(1);
    expect(data.branchPoints[0].id).toBe('1-deployment');
    expect(data.branchPoints[0].recommendation).toBeDefined();
    expect(['default', 'ranker']).toContain(data.branchPoints[0].recommendation.reason.kind);
    expect(data.skipPoints).toHaveLength(1);
    expect(data.skipPoints[0].stepNumber).toBe(4);
    expect(data.skipPoints[0].skip).toBe(false);
  });

  it('404 when branchingEnabled=false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });

    const res = await project.get(`/api/branches/decide?slug=${SLUG}&nocache=1`).catch(e => e);
    expect(res.response?.status || res.status).toBe(404);
  });

  it('404 for unknown slug', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const res = await project.get('/api/branches/decide?slug=does-not-exist&nocache=1').catch(e => e);
    expect(res.response?.status || res.status).toBe(404);
  });

  it('lowercases slug input', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const { status, data } = await project.get(`/api/branches/decide?slug=__TEST__-BRANCHED&nocache=1`);
    expect(status).toBe(200);
    expect(data.branchPoints).toHaveLength(1);
  });

  it('skipPoints carries skipLabel + skipReason through', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const { data } = await project.get(`/api/branches/decide?slug=${SLUG}&nocache=1`);
    expect(data.skipPoints[0]).toMatchObject({
      stepNumber: 4,
      skip: false,
      skipLabel: 'Skip',
      skipReason: 'You have it',
    });
  });
});
