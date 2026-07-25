import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVersionHandler, versionHandler } from '../../lib/version-handler.js';

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    type(t) { this.headers['content-type'] = t; return this; },
  };
}

describe('version-handler', () => {
  it('serves version.json contents merged with runtime environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const file = join(dir, 'version.json');
    writeFileSync(file, JSON.stringify({ version: '1.4.2-5-ga7518452', gitSha: 'a7518452', builtAt: '2026-07-25T09:44:00Z' }));
    const handler = createVersionHandler({ versionFilePath: file, resolveEnv: () => ({ id: 'prod', label: 'PROD', space: 'prod' }) });
    const res = mockRes();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: '1.4.2-5-ga7518452', gitSha: 'a7518452', environment: 'prod', builtAt: '2026-07-25T09:44:00Z' });
  });

  it('falls back to dev defaults when version.json is absent', () => {
    const handler = createVersionHandler({ versionFilePath: join(tmpdir(), 'does-not-exist-xyz.json'), resolveEnv: () => ({ id: 'local', label: 'LOCAL', space: null }) });
    const res = mockRes();
    handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 'dev', gitSha: 'local', environment: 'local', builtAt: null });
  });

  it('falls back to dev defaults when version.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const file = join(dir, 'version.json');
    writeFileSync(file, '{ not json');
    const handler = createVersionHandler({ versionFilePath: file, resolveEnv: () => ({ id: 'qa', label: 'QA', space: 'qa' }) });
    const res = mockRes();
    handler({}, res);
    expect(res.body).toEqual({ version: 'dev', gitSha: 'local', environment: 'qa', builtAt: null });
  });

  it('exports a default versionHandler bound to the real resolver', () => {
    expect(typeof versionHandler).toBe('function');
  });
});
