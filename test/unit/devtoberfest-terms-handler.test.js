// test/unit/devtoberfest-terms-handler.test.js
// /api/devtoberfest/terms returns the raw markdown termsText + current
// termsVersion. Client (TermsDialog.vue) renders the markdown — server
// stays renderer-free.
//
// Multi-row schema (spec 2026-06-24): handler selects WHERE isActive=true.
// No active row ⇒ 503 EVENT_NOT_CONFIGURED (same behaviour as
// statusHandler — there's no implicit bootstrap anymore).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/terms', () => {
  let DevtoberfestConfig;

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('returns the active config\'s terms text + version', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: true,
      termsText: '# Devtoberfest\n\n1. Eligibility...',
      termsVersion: 3,
    });
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('# Devtoberfest\n\n1. Eligibility...');
    expect(res.data.version).toBe(3);
  });

  it('returns 503 when no row is active', async () => {
    const res = await project.axios.get('/api/devtoberfest/terms', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns 503 when only inactive rows exist', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: false,
      termsText: '# Historic',
      termsVersion: 99,
    });
    const res = await project.axios.get('/api/devtoberfest/terms', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
  });

  it('picks the active row when multiple rows coexist', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: false,
      termsText: '# Old',
      termsVersion: 1,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: true,
      termsText: '# Current',
      termsVersion: 5,
    });
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('# Current');
    expect(res.data.version).toBe(5);
  });
});
