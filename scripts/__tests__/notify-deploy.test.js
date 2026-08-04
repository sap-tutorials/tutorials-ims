// scripts/__tests__/notify-deploy.test.js
// vitest globals (describe, it, expect, vi) are injected by vitest's
// `globals: true` config — no require('vitest') needed in CJS test files.
const { notifyDeploy } = require('../deploy-mta.cjs');

const CFG = { srvUrl: 'https://srv.example.com' };

describe('notifyDeploy (best-effort)', () => {
  it('POSTs the phase payload with bearer auth', async () => {
    const calls = [];
    const fetchImpl = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, status: 202 }); };
    await notifyDeploy('start', CFG, { env: 'prod', version: '1.0.0' }, { fetchImpl, apiKey: 'k', log: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://srv.example.com/ops/deploy-event');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(calls[0].opts.body);
    expect(body).toMatchObject({ phase: 'start', env: 'prod', version: '1.0.0' });
  });
  it('never rejects on network error', async () => {
    const fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      notifyDeploy('end', CFG, { env: 'dev' }, { fetchImpl, apiKey: 'k', log: () => {} })
    ).resolves.toBeUndefined();
  });
  it('no-ops (no fetch) when apiKey is absent', async () => {
    const fetchImpl = vi.fn();
    await notifyDeploy('start', CFG, { env: 'dev' }, { fetchImpl, apiKey: '', log: () => {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
