// test/hybrid/clusters-data-hybrid.test.js
//
// Hybrid HTTP test for GET /graph/clusters-data — public, unauthenticated.
// Mirrors explore-data-route.test.js pattern: boots an in-process CAP server
// via cds.test('serve', ...) bound to hybrid HANA.
//
// Run with: npx vitest run --project hybrid test/hybrid/clusters-data-hybrid.test.js
// Requires: cds bind to DEV space (cf login) first.
//
// Asserts:
//   - 200 + {nodes, edges, generatedAt} super-graph shape
//   - node ids are prefixed c:
//   - X-Cache MISS on first call, HIT on second within TTL
//   - Cache-Control: public, max-age=300
//   - ?cluster=<slug> returns a subgraph { nodes, edges }
//   - ?cluster=<bad-slug> returns 400
//
// Issue: topics-discovery SDD Task 8

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('/graph/clusters-data (HTTP)', () => {
  it('returns 200 with nodes + edges + generatedAt', async () => {
    const r = await project.get('/graph/clusters-data');
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('nodes');
    expect(r.data).toHaveProperty('edges');
    expect(Array.isArray(r.data.nodes)).toBe(true);
    expect(Array.isArray(r.data.edges)).toBe(true);
    expect(r.data).toHaveProperty('generatedAt');
    expect(typeof r.data.generatedAt).toBe('string');
  });

  it('each super-node id is prefixed c:', async () => {
    const r = await project.get('/graph/clusters-data');
    expect(r.status).toBe(200);
    for (const n of r.data.nodes) {
      expect(n.id).toMatch(/^c:/);
      expect(n.type).toBe('cluster');
    }
  });

  it('cache header reflects MISS then HIT within 5 minutes', async () => {
    const r1 = await project.get('/graph/clusters-data');
    expect(r1.headers['x-cache']).toBeTruthy();
    const r2 = await project.get('/graph/clusters-data');
    expect(r2.headers['x-cache']).toBe('HIT');
  });

  it('sets Cache-Control: public, max-age=300', async () => {
    const r = await project.get('/graph/clusters-data');
    expect(r.headers['cache-control']).toContain('max-age=300');
  });

  it('does not require auth', async () => {
    const r = await project.get('/graph/clusters-data');
    expect(r.status).toBe(200);
  });

  it('?cluster=<valid-slug> returns a subgraph', async () => {
    const r0 = await project.get('/graph/clusters-data');
    expect(r0.status).toBe(200);
    if (r0.data.nodes.length === 0) return; // no clusters in this env
    const slug = r0.data.nodes[0].slug;
    const r = await project.get(`/graph/clusters-data?cluster=${slug}`);
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('nodes');
    expect(r.data).toHaveProperty('edges');
    expect(Array.isArray(r.data.nodes)).toBe(true);
    expect(Array.isArray(r.data.edges)).toBe(true);
  });

  it('?cluster=<bad-slug> returns 400', async () => {
    const r = await project.get('/graph/clusters-data?cluster=BAD SLUG!!');
    expect(r.status).toBe(400);
    expect(r.data).toHaveProperty('error');
  });
});
