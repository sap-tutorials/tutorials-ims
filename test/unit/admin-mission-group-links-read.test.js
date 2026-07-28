// test/unit/admin-mission-group-links-read.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Missions/Groups read: preview links (published-gated)', () => {
  beforeAll(async () => {
    const { Missions, Groups } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries([
      { ID: cds.utils.uuid(), slug: 'pub-mission', title: 'Pub Mission', published: true },
      { ID: cds.utils.uuid(), slug: 'unpub-mission', title: 'Unpub Mission', published: false },
    ]);
    await INSERT.into(Groups).entries([
      { ID: cds.utils.uuid(), slug: 'pub-group', title: 'Pub Group', published: true },
      { ID: cds.utils.uuid(), slug: 'unpub-group', title: 'Unpub Group', published: false },
    ]);
  });

  it('published mission exposes mission-prefixed QA + main links', async () => {
    const { status, data } = await project.get(
      "/admin/Missions?$filter=slug eq 'pub-mission'" +
      '&$select=slug,published,qaPreviewUrl,mainPreviewUrl,qaPreviewLabel,mainPreviewLabel',
      adminAuth);
    expect(status).toBe(200);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe('/tutorials-qa/mission-pub-mission');
    expect(row.mainPreviewUrl).toBe('/tutorials/mission-pub-mission');
    expect(row.mainPreviewLabel).toBe('View Live Mission');
  });

  it('unpublished mission exposes no links', async () => {
    const { data } = await project.get(
      "/admin/Missions?$filter=slug eq 'unpub-mission'&$select=slug,qaPreviewUrl,mainPreviewUrl",
      adminAuth);
    const row = data.value[0];
    expect(row.qaPreviewUrl ?? null).toBeNull();
    expect(row.mainPreviewUrl ?? null).toBeNull();
  });

  it('published group exposes group-prefixed links with Group label', async () => {
    const { data } = await project.get(
      "/admin/Groups?$filter=slug eq 'pub-group'" +
      '&$select=slug,published,qaPreviewUrl,mainPreviewUrl,mainPreviewLabel',
      adminAuth);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe('/tutorials-qa/group-pub-group');
    expect(row.mainPreviewUrl).toBe('/tutorials/group-pub-group');
    expect(row.mainPreviewLabel).toBe('View Live Group');
  });
});
