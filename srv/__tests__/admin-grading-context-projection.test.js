// srv/__tests__/admin-grading-context-projection.test.js
//
// Task 8 of spec 2026-11-12-grading-context (#3090):
// Assert that AdminService exposes a read-only TutorialGradingContext
// projection, that POST/PATCH are rejected, that the `context` field
// is present, and that the Tutorials→gradingContext association resolves.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const auth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

const NS = 'com.sap.developers.ims';
const TUT_ID = 'aaaaaaaa-gc01-0000-0000-000000000001';
const SLUG = 'grading-context-test-tutorial';

describe('AdminService — TutorialGradingContext projection (Task 8 / #3090)', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
    const { Tutorials, TutorialGradingContext } = cds.entities(NS);

    await DELETE.from(TutorialGradingContext).where({ tutorial_ID: TUT_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_ID });

    await INSERT.into(Tutorials).entries([
      { ID: TUT_ID, title: 'Grading Context Test Tutorial', slug: SLUG }
    ]);
    await INSERT.into(TutorialGradingContext).entries([
      { tutorial_ID: TUT_ID, context: 'This tutorial covers SAP BTP basics.' }
    ]);
  });

  afterAll(async () => {
    const { Tutorials, TutorialGradingContext } = cds.entities(NS);
    await DELETE.from(TutorialGradingContext).where({ tutorial_ID: TUT_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_ID });
  });

  it('GET of TutorialGradingContext returns the row with context field', async () => {
    const { data, status } = await project.get(
      `/admin/TutorialGradingContext?$filter=tutorial_ID eq '${TUT_ID}'`,
      auth
    );
    expect(status).toBe(200);
    expect(data.value).toBeInstanceOf(Array);
    expect(data.value).toHaveLength(1);
    expect(data.value[0].context).toBe('This tutorial covers SAP BTP basics.');
  });

  it('POST to TutorialGradingContext is rejected (readonly)', async () => {
    const { status } = await project.post(
      '/admin/TutorialGradingContext',
      { tutorial_ID: 'bbbbbbbb-gc01-0000-0000-000000000002', context: 'injected' },
      auth
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('PATCH to TutorialGradingContext is rejected (readonly)', async () => {
    const { status } = await project.patch(
      `/admin/TutorialGradingContext(tutorial_ID='${TUT_ID}')`,
      { context: 'modified' },
      auth
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('Tutorials→gradingContext association resolves via $expand', async () => {
    const { data, status } = await project.get(
      `/admin/Tutorials(ID=${TUT_ID},IsActiveEntity=true)?$expand=gradingContext`,
      auth
    );
    expect(status).toBe(200);
    expect(data.gradingContext).toBeDefined();
    expect(data.gradingContext.context).toBe('This tutorial covers SAP BTP basics.');
  });
});
