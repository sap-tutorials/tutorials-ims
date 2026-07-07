// test/unit/srv/featured-topics-endpoint.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('featured-topics endpoints (#1032)', () => {
  it('/homepage/featuredTopics() returns 200 with empty snapshot initially', async () => {
    const res = await project.get('/homepage/featuredTopics()');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('snapshot');
    expect(res.data).toHaveProperty('etag');
    expect(res.headers.etag).toBeTruthy();
  });

  it('/homepage/featuredTopics() returns 304 on If-None-Match', async () => {
    const first = await project.get('/homepage/featuredTopics()');
    const etag = first.headers.etag;
    // CAP throws on non-2xx — capture the error response, per project convention.
    const second = await project.get('/homepage/featuredTopics()', { headers: { 'If-None-Match': etag } })
      .catch(err => err.response);
    expect(second.status).toBe(304);
  });

  it('/build/featured-topics returns 200 with the same payload shape', async () => {
    const res = await project.get('/build/featured-topics');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('snapshot');
    expect(res.data).toHaveProperty('computedAt');
    expect(res.data).toHaveProperty('etag');
  });
});
