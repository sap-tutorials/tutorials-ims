import { describe, it, expect } from 'vitest';

// CommonJS import under vitest — interop via default-export.
import guard from '../check-deploy-cap-target.cjs';
const { evaluateDeployTarget } = guard as {
  evaluateDeployTarget: (raw: string | undefined) => { ok: boolean; reason: string };
};

describe('check-deploy-cap-target: evaluateDeployTarget', () => {
  it('rejects an unset / empty CAP_BASE_URL', () => {
    expect(evaluateDeployTarget(undefined)).toEqual({ ok: false, reason: 'unset' });
    expect(evaluateDeployTarget('')).toEqual({ ok: false, reason: 'unset' });
    expect(evaluateDeployTarget('   ')).toEqual({ ok: false, reason: 'unset' });
  });

  it('rejects localhost / loopback targets (empty local CAP)', () => {
    expect(evaluateDeployTarget('http://localhost:4004').reason).toBe('localhost');
    expect(evaluateDeployTarget('http://127.0.0.1:4004').reason).toBe('localhost');
    expect(evaluateDeployTarget('http://[::1]:4004').reason).toBe('localhost');
    expect(evaluateDeployTarget('http://0.0.0.0:4004').reason).toBe('localhost');
    expect(evaluateDeployTarget('http://localhost:4004').ok).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(evaluateDeployTarget('not a url')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts an explicit deployed backend', () => {
    const dev = 'https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com';
    expect(evaluateDeployTarget(dev)).toEqual({ ok: true, reason: 'ok' });
  });

  it('accepts any non-loopback host, including trailing paths and ports', () => {
    expect(evaluateDeployTarget('https://srv.example.com/').ok).toBe(true);
    expect(evaluateDeployTarget('https://srv.example.com:443/build').ok).toBe(true);
  });

  it('is case-insensitive on the localhost hostname', () => {
    expect(evaluateDeployTarget('http://LOCALHOST:4004').reason).toBe('localhost');
  });
});
