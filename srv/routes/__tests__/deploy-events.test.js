// srv/routes/__tests__/deploy-events.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

// Mock the fail-open alerting module so no ANS/DB is needed.
const raiseMock = vi.fn(() => Promise.resolve());
vi.mock('../../lib/alerting.js', () => ({ raise: (...a) => raiseMock(...a) }));

const { register, phaseToPayload } = await import('../deploy-events.js');

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  register(app); // no authMw → handler runs unguarded
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server?.close(r)); });

function post(body) {
  return fetch(`${baseUrl}/ops/deploy-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('phaseToPayload', () => {
  it('maps start → DeployStarted / NOTICE', () => {
    const p = phaseToPayload('start', { env: 'prod', version: '1.2.3' });
    expect(p.eventType).toBe('DeployStarted');
    expect(p.severity).toBe('NOTICE');
    expect(p.resource).toEqual({ resourceName: 'deploy-prod', resourceType: 'deployment' });
    expect(p.subject).toContain('prod');
    expect(p.subject).toContain('1.2.3');
  });
  it('maps end → DeployFinished / NOTICE', () => {
    expect(phaseToPayload('end', { env: 'dev' }).eventType).toBe('DeployFinished');
    expect(phaseToPayload('end', { env: 'dev' }).severity).toBe('NOTICE');
  });
  it('maps fail → DeployFailed / ERROR with detail in body', () => {
    const p = phaseToPayload('fail', { env: 'qa', detail: 'smoke gate failed' });
    expect(p.eventType).toBe('DeployFailed');
    expect(p.severity).toBe('ERROR');
    expect(p.body).toContain('smoke gate failed');
  });
});

describe('POST /ops/deploy-event', () => {
  it('202 + raises alert for a valid start', async () => {
    raiseMock.mockClear();
    const res = await post({ phase: 'start', env: 'prod', version: '9.9.9' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10)); // let the void raise() settle
    expect(raiseMock).toHaveBeenCalledOnce();
    expect(raiseMock.mock.calls[0][0].eventType).toBe('DeployStarted');
  });
  it('400 on missing/invalid phase, no raise', async () => {
    raiseMock.mockClear();
    const res = await post({ env: 'prod' });
    expect(res.status).toBe(400);
    expect(raiseMock).not.toHaveBeenCalled();
  });
  it('still 202 when raise rejects (fail-open)', async () => {
    raiseMock.mockClear();
    raiseMock.mockImplementationOnce(() => Promise.reject(new Error('ANS down')));
    const res = await post({ phase: 'end', env: 'dev' });
    expect(res.status).toBe(202);
  });
});
