// test/unit/devtoberfest-terms-handler.test.js
// /api/devtoberfest/terms returns the raw markdown termsText + current
// termsVersion. Client (TermsDialog.vue) renders the markdown — server
// stays renderer-free in Phase 1 to keep the dependency surface tiny.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/devtoberfest/terms', () => {
  let DevtoberfestConfig;
  const SINGLETON_ID = '00000000-0000-0000-0000-00d0fe57feed';

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('returns configured terms text + version', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: SINGLETON_ID,
      termsText: '# Devtoberfest\n\n1. Eligibility...',
      termsVersion: 3,
    });
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('# Devtoberfest\n\n1. Eligibility...');
    expect(res.data.version).toBe(3);
  });

  it('returns empty text + default version on fresh singleton', async () => {
    const res = await project.axios.get('/api/devtoberfest/terms');
    expect(res.status).toBe(200);
    expect(res.data.text).toBe('');
    expect(res.data.version).toBe(1);
  });
});
