// test/unit/srv/homepage-topic-cluster-volatile.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('/homepage/topicClusterVolatile()', () => {
  it('returns 200 with clusters[], an etag, and Cache-Control', async () => {
    await project;
    const res = await project.get('/homepage/topicClusterVolatile()');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('etag');
    expect(res.data).toHaveProperty('clusters');
    expect(Array.isArray(res.data.clusters)).toBe(true);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('honors If-None-Match with a 304', async () => {
    await project;
    const first = await project.get('/homepage/topicClusterVolatile()');
    const etag = first.data.etag;
    try {
      const second = await project.get('/homepage/topicClusterVolatile()', { headers: { 'If-None-Match': etag } });
      expect(second.status).toBe(304);
    } catch (e) {
      // axios throws on 304 in some setups; assert the status off the error response.
      expect(e.response?.status).toBe(304);
    }
  });
});
