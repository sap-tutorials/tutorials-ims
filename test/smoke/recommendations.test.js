// test/smoke/recommendations.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

const SRV_URL = process.env.SMOKE_SRV_URL || BASE_URL;
const KNOWN_SLUG = 'abap-cloud-ui-from-interface';

describe('Personalized recommendations endpoint', () => {
  it('400 on missing slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations`);
    expect(res.status).toBe(400);
  });

  it('404 on unknown slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations?slug=__bogus__`);
    expect(res.status).toBe(404);
  });

  it('200 with valid shape on known slug', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/api/recommendations?slug=${KNOWN_SLUG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      currentSlug: KNOWN_SLUG,
      personalized: expect.any(Boolean),
      recommendations: expect.any(Array)
    });
    expect(body.recommendations.length).toBeLessThanOrEqual(3);
    for (const rec of body.recommendations) {
      expect(rec).toMatchObject({ slug: expect.any(String), title: expect.any(String) });
    }
  });
});

describe('Personalized rail wrapper in Hugo HTML', () => {
  it('renders data-recommend-slug attribute on a known tutorial page', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${KNOWN_SLUG}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(new RegExp(`data-recommend-slug=["']${KNOWN_SLUG}["']`));
    expect(html).toContain('data-recommend-target');
  });
});
