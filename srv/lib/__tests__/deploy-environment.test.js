// srv/lib/__tests__/deploy-environment.test.js
//
// Issue #1268 — unit coverage for the CF-space → environment-label resolver.

import { describe, it, expect } from 'vitest';
import { resolveDeployEnvironment } from '../deploy-environment.js';

describe('resolveDeployEnvironment', () => {
  it('returns LOCAL when VCAP_APPLICATION is absent', () => {
    expect(resolveDeployEnvironment(undefined)).toEqual({
      id: 'local', label: 'LOCAL', space: null
    });
  });

  it('returns LOCAL when VCAP_APPLICATION is malformed JSON', () => {
    expect(resolveDeployEnvironment('{not-json')).toEqual({
      id: 'local', label: 'LOCAL', space: null
    });
  });

  it('returns LOCAL when space_name is missing/empty', () => {
    expect(resolveDeployEnvironment('{}').id).toBe('local');
    expect(resolveDeployEnvironment(JSON.stringify({ space_name: '' })).id).toBe('local');
  });

  it('maps the dev space to DEV', () => {
    const r = resolveDeployEnvironment(JSON.stringify({ space_name: 'dev' }));
    expect(r).toEqual({ id: 'dev', label: 'DEV', space: 'dev' });
  });

  it('maps the prod space to PROD', () => {
    const r = resolveDeployEnvironment(JSON.stringify({ space_name: 'prod' }));
    expect(r).toEqual({ id: 'prod', label: 'PROD', space: 'prod' });
  });

  it('is case-insensitive on the space name', () => {
    expect(resolveDeployEnvironment(JSON.stringify({ space_name: 'PROD' })).id).toBe('prod');
    expect(resolveDeployEnvironment(JSON.stringify({ space_name: 'Production' })).id).toBe('prod');
  });

  it('maps qa/test spaces to QA', () => {
    expect(resolveDeployEnvironment(JSON.stringify({ space_name: 'qa' })).id).toBe('qa');
    expect(resolveDeployEnvironment(JSON.stringify({ space_name: 'test' }))).toEqual({
      id: 'qa', label: 'TEST', space: 'test'
    });
  });

  it('surfaces an unknown space name verbatim (uppercased) rather than guessing', () => {
    const r = resolveDeployEnvironment(JSON.stringify({ space_name: 'staging' }));
    expect(r).toEqual({ id: 'other', label: 'STAGING', space: 'staging' });
  });
});
