// test/unit/devtoberfest-faq-endpoint.test.js
// /api/devtoberfest/faq returns the raw markdown faqText.
// Client renders the markdown — server stays renderer-free.
//
// Multi-row schema (spec 2026-06-24): handler selects WHERE isActive=true.
// No active row => 503 EVENT_NOT_CONFIGURED (mirrors termsHandler behaviour).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/faq', () => {
  let DevtoberfestConfig;

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('returns the active config\'s faq text', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: true,
      faqText: '## Q1\n\nAnswer one.\n\n## Q2\n\nAnswer two.',
    });
    const res = await project.axios.get('/api/devtoberfest/faq');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('## Q1\n\nAnswer one.\n\n## Q2\n\nAnswer two.');
  });

  it('returns 503 when no row is active', async () => {
    const res = await project.axios.get('/api/devtoberfest/faq', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('returns 503 when only inactive rows exist', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: false,
      faqText: '## Old FAQ',
    });
    const res = await project.axios.get('/api/devtoberfest/faq', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(503);
  });

  it('picks the active row\'s faqText when multiple rows coexist', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: false,
      faqText: '## Old FAQ',
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(),
      isActive: true,
      faqText: '## Current FAQ\n\nUse this one.',
    });
    const res = await project.axios.get('/api/devtoberfest/faq');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('## Current FAQ\n\nUse this one.');
  });
});
