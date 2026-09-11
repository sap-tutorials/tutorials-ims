import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';
import { invalidateContentCache } from '../../srv/lib/content-store.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const b64gz = html => gzipSync(Buffer.from(html)).toString('base64');
const API_KEY = 'k';

describe('advisory provenance headers', () => {
  let ContentCurrent, ContentFiles, ContentManifest;

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    ({ ContentCurrent, ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims'));
  });

  afterAll(() => __resetFlagsForTest());

  beforeEach(async () => {
    invalidateContentCache();
    await DELETE.from(ContentCurrent);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);

    // Publish 'demo' so it is servable (ContentFiles path, same flow as content-store.test.js).
    await project.axios.post('/content/publish', {
      trigger: 'provenance-headers-test',
      files: { demo: b64gz('<h1>demo</h1>') },
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    // Insert a ContentCurrent row so loadProvenanceInputs finds the slug.
    // No FreshnessReport row → report will be null → deriveConfidence returns 'unknown'.
    await INSERT.into(ContentCurrent).entries({
      slug: 'demo',
      contentHash: 'a'.repeat(64),
      mimeType: 'text/html',
    });
  });

  it('omits headers when flag OFF', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', false);
    const res = await project.axios.get('/content/tutorials/demo');
    expect(res.status).toBe(200);
    expect(res.headers['x-freshness-confidence']).toBeUndefined();
    expect(res.headers['x-content-provenance']).toBeUndefined();
  });

  it('emits headers on cache-miss AND cache-hit when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    const miss = await project.axios.get('/content/tutorials/demo');   // fills LRU
    expect(miss.status).toBe(200);
    expect(miss.headers['x-freshness-confidence']).toBe('unknown');
    expect(miss.headers['x-content-provenance']).toBe('/content/tutorials/demo/provenance');
    const hit = await project.axios.get('/content/tutorials/demo');    // LRU hit
    expect(hit.headers['x-content-source']).toBe('cache');
    expect(hit.headers['x-freshness-confidence']).toBe('unknown');
    expect(hit.headers['x-content-provenance']).toBe('/content/tutorials/demo/provenance');
  });
});
