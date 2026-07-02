import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';
const ORIGINAL_KEY = process.env.CONTENT_API_KEY;
// #887: previously this fell back to the hardcoded DEV key literal.
// Silently using DEV credentials against DEV HANA is the shared-secret
// pattern #887 is fixing. Fail loud instead. Export CONTENT_API_KEY
// (fetch from BTP credstore per rotate-content-api-key runbook) before
// running the hybrid tests.
if (!ORIGINAL_KEY) {
  throw new Error(
    'CONTENT_API_KEY not set — export it before running the hybrid repo-catalog test. ' +
    'See docs/developers/operations/rotate-content-api-key.md.'
  );
}
const TEST_TOKEN = ORIGINAL_KEY;

function testEntries() {
  return {
    [`${TEST_PREFIX}alpha`]: {
      slug: `${TEST_PREFIX}alpha`,
      repo: 'cap-getting-started',
      branch: 'main',
      owner: 'sap-tutorials',
      topics: ['cap', 'nodejs'],
    },
    [`${TEST_PREFIX}beta`]: {
      slug: `${TEST_PREFIX}beta`,
      repo: 'fiori-elements',
      branch: 'main',
    },
  };
}

describe.runIf(isSafeForWrites())('RepoCatalog endpoints (hybrid)', () => {
  beforeAll(() => {
    process.env.CONTENT_API_KEY = TEST_TOKEN;
  });

  afterAll(async () => {
    if (ORIGINAL_KEY === undefined) delete process.env.CONTENT_API_KEY;
    else process.env.CONTENT_API_KEY = ORIGINAL_KEY;

    const { RepoCatalog } = cds.entities('com.sap.developers.ims');
    await DELETE.from(RepoCatalog).where({ slug: { like: `${TEST_PREFIX}%` } });
  });

  it('POST without Authorization header returns 401', async () => {
    const res = await project.post('/build/repo-catalog', { entries: testEntries() }, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(401);
  });

  it('POST with bad bearer token returns 403', async () => {
    const res = await project.post('/build/repo-catalog', { entries: testEntries() }, {
      headers: { Authorization: 'Bearer not-the-real-key' },
      validateStatus: () => true,
    });
    expect(res.status).toBe(403);
  });

  it('POST with empty entries returns 400 (refuses to wipe catalog)', async () => {
    const res = await project.post('/build/repo-catalog', { entries: {} }, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      validateStatus: () => true,
    });
    expect(res.status).toBe(400);
  });

  it('POST with valid bearer upserts catalog and persists payload', async () => {
    // Seed: write a row that should be replaced on POST. The handler does
    // delete-then-insert in one tx so this row must vanish if POST succeeds.
    const { RepoCatalog } = cds.entities('com.sap.developers.ims');
    await INSERT.into(RepoCatalog).entries({
      slug: `${TEST_PREFIX}stale`,
      repo: 'old-repo',
      branch: 'old',
      payload: JSON.stringify({ slug: `${TEST_PREFIX}stale`, repo: 'old-repo', branch: 'old' }),
      lastSyncedAt: new Date().toISOString(),
    });

    const res = await project.post('/build/repo-catalog', { entries: testEntries() }, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(2);

    const rows = await SELECT.from(RepoCatalog).where({ slug: { like: `${TEST_PREFIX}%` } });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual([`${TEST_PREFIX}alpha`, `${TEST_PREFIX}beta`]);

    const alpha = rows.find(r => r.slug === `${TEST_PREFIX}alpha`);
    const parsed = JSON.parse(alpha.payload);
    expect(parsed.repo).toBe('cap-getting-started');
    expect(parsed.topics).toEqual(['cap', 'nodejs']);
  });

  it('GET returns slug-keyed map matching DiscoveredTutorial shape', async () => {
    const res = await project.get('/build/repo-catalog');
    expect(res.status).toBe(200);
    expect(typeof res.data).toBe('object');

    const alpha = res.data[`${TEST_PREFIX}alpha`];
    expect(alpha).toBeTruthy();
    expect(alpha.slug).toBe(`${TEST_PREFIX}alpha`);
    expect(alpha.repo).toBe('cap-getting-started');
    expect(alpha.branch).toBe('main');
  });

  it('POST without CONTENT_API_KEY env returns 503', async () => {
    delete process.env.CONTENT_API_KEY;
    try {
      const res = await project.post('/build/repo-catalog', { entries: testEntries() }, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        validateStatus: () => true,
      });
      expect(res.status).toBe(503);
    } finally {
      process.env.CONTENT_API_KEY = TEST_TOKEN;
    }
  });
});
