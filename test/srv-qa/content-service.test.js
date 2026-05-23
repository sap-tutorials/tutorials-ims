import './_setup.js'; // installs cds.once monkey-patch + folders.srv redirect (see file for rationale)
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

// Set CONTENT_API_KEY_QA BEFORE cds.test() is invoked.
// srv-qa/server.js registers a cds.on('bootstrap') handler that calls
// createContentHandlers({ apiKeyEnv: 'CONTENT_API_KEY_QA' }).
// The contentAuthMiddleware closure reads process.env[apiKeyEnv] per request
// (not at factory creation), so setting it here is sufficient for the bearer
// auth check — but setting it before bootstrap is the safest approach.
const apiKey = 'test-key';
process.env.CONTENT_API_KEY_QA = apiKey;

// Serve only the QA search service. The QA namespace now includes its own
// JobLocks, PipelineLog, PipelineLogItems, and JobLogItems entities
// (added in db-qa/schema.cds as part of Task 8.5), so there is no longer any
// need to load db/schema.cds to satisfy the lock/log paths inside publishHandler.
const project = cds.test('serve', 'srv-qa/search-service.cds', '--in-memory');

// Test slug must pass the VALID_SLUG regex: /^[a-z0-9][a-z0-9-]*$/
// (underscores are not allowed — __TEST__qa would return 400)
const TEST_SLUG = 'test-qa-content';

describe('QA content endpoints', () => {
  it('publishes a slug then serves decompressed HTML', async () => {
    const html = '<html>test-qa-content hello</html>';
    const gz = gzipSync(Buffer.from(html)).toString('base64');

    await project.post(
      '/content/publish',
      { trigger: 'unit-test', hugoVersion: '0.147.7', files: { [TEST_SLUG]: gz } },
      { headers: { authorization: `Bearer ${apiKey}` } }
    );

    const { data } = await project.get(`/content/tutorials/${TEST_SLUG}`);
    expect(data).toMatch('test-qa-content hello');
  });

  it('returns 401 without bearer', async () => {
    let caught;
    try {
      await project.post('/content/publish', { trigger: 't', hugoVersion: '0', files: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught?.response?.status ?? caught?.status).toBe(401);
  });

  it('hashes endpoint reflects published slugs', async () => {
    const { data } = await project.get('/content/hashes');
    expect(data[TEST_SLUG]).toMatch(/^[a-f0-9]{64}$/);
  });
});
