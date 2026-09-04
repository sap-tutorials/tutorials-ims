// srv/__tests__/author-reporting-service.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

const { GET, expect: _e } = cds.test('serve', '--project', '.', '--in-memory');

// `developer:developer` has Tutorial.Author per .cdsrc.json
// (confirmed via author-service-os-variants.test.js pattern; the `author`
// mock user exists in .cdsrc.json but has no password set, so `developer`
// is the correct credential for /author/ HTTP tests in this project)
const AUTHOR = { auth: { username: 'developer', password: 'developer' } };

describe('AuthorService reporting projections', () => {
  it('exposes the four reporting entities on /author with Tutorial.Author auth', async () => {
    for (const entity of [
      'AuthorTutorialEngagement',
      'AuthorTutorialCompletions',
      'AuthorSurveyDistribution',
      'AuthorTutorialParents'
    ]) {
      const res = await GET(`/author/${entity}?$top=1`, AUTHOR);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.value)).toBe(true);
    }
  });

  it('rejects anonymous access to /author reporting entities', async () => {
    const res = await GET('/author/AuthorTutorialEngagement', { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('exposes Missions and Groups value-help collections on /author (#2138 filter value help)', async () => {
    for (const entity of ['Missions', 'Groups']) {
      const res = await GET(`/author/${entity}?$top=1&$select=title,slug`, AUTHOR);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.value)).toBe(true);
    }
  });
});
