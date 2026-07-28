// test/unit/admin-tutorial-links-read.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Tutorials read: lifecycle source/preview links', () => {
  let activeSlug;

  beforeAll(async () => {
    // Seed an ACTIVE tutorial so the decorator has something to populate.
    const db = await cds.connect.to('db');
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    activeSlug = 'test-lifecycle-links-active';
    await db.run(
      INSERT.into(Tutorials).entries([
        { ID: cds.utils.uuid(), title: 'Test Lifecycle Links', slug: activeSlug, status: 'ACTIVE' },
      ]),
    );
  });

  it('an ACTIVE tutorial exposes relative QA + main preview links', async () => {
    expect(activeSlug, 'no ACTIVE tutorial in seed data').toBeTruthy();
    const { status, data } = await project.get(
      `/admin/Tutorials?$filter=slug eq '${activeSlug}'` +
      `&$select=slug,status,qaPreviewUrl,mainPreviewUrl,qaPreviewLabel,mainPreviewLabel`,
      adminAuth);
    expect(status).toBe(200);
    const row = data.value[0];
    expect(row.qaPreviewUrl).toBe(`/tutorials-qa/${activeSlug}`);
    expect(row.mainPreviewUrl).toBe(`/tutorials/${activeSlug}`);
    expect(row.qaPreviewLabel).toBe('View QA Preview');
    expect(row.mainPreviewLabel).toBe('View Live Tutorial');
  });
});
