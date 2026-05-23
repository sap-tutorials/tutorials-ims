// test/unit/handlers/recommendations.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetForTest } from '../../../srv/lib/recommend.js';

const recommendMock = vi.fn();
vi.mock('../../../srv/lib/recommend.js', async (orig) => ({
  ...(await orig()),
  recommend: (...args) => recommendMock(...args)
}));

let recommendationsHandler;
beforeEach(async () => {
  __resetForTest();
  recommendMock.mockReset();
  ({ recommendationsHandler } = await import('../../../srv/handlers/recommendations.js'));
});

function makeRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
}

describe('GET /api/recommendations handler', () => {
  it('400 on missing slug', async () => {
    const res = makeRes();
    await recommendationsHandler({ query: {}, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('404 when recommend reports unknown_slug', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'x', personalized: false, recommendations: [], reason: 'unknown_slug' });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'x' }, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 with body for happy path', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: true, recommendations: [{ slug: 'b', title: 'B', primaryTag: 'CAP', score: 0.5 }] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: { id: 'u1' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ currentSlug: 'a', personalized: true }));
  });

  it('clamps limit=99 to 6 before calling recommend', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: false, recommendations: [] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a', limit: '99' }, user: null }, res);
    expect(recommendMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 6 }), expect.any(Object));
  });

  it('500 when recommend throws', async () => {
    recommendMock.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: null }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('passes user=null when req.user is missing or anonymous', async () => {
    recommendMock.mockResolvedValueOnce({ currentSlug: 'a', personalized: false, recommendations: [] });
    const res = makeRes();
    await recommendationsHandler({ query: { slug: 'a' }, user: { id: 'anonymous' } }, res);
    expect(recommendMock).toHaveBeenCalledWith(expect.objectContaining({ user: null }), expect.any(Object));
  });
});
