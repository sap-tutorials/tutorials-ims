/**
 * Unit tests for srv/lib/deploy-self-heal.js — self-heal CAP-sourced static
 * content once per CF deploy.
 *
 * Context: incident 2026-07-12 — a `cf deploy` shipped an empty /concepts/
 * index (built against local CAP) and reset the approuter's ephemeral disk,
 * wiping the content-rebuild output. This module dispatches a catalog-only
 * rebuild on the first boot after each new deploy version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the two collaborators. We assert on their call args, not real IO.
vi.mock('../../../srv/jobs/job-lock.js', () => ({
  acquireLock: vi.fn(),
}));
vi.mock('../../../srv/lib/rebuild-trigger.js', () => ({
  scheduleRebuild: vi.fn().mockResolvedValue(undefined),
}));

import { acquireLock } from '../../../srv/jobs/job-lock.js';
import { scheduleRebuild } from '../../../srv/lib/rebuild-trigger.js';
import { selfHealOnDeploy, currentDeployVersion } from '../../../srv/lib/deploy-self-heal.js';

const VER_A = JSON.stringify({ application_version: 'aaaa-1111' });
const VER_B = JSON.stringify({ application_version: 'bbbb-2222' });

describe('deploy-self-heal', () => {
  const origVcap = process.env.VCAP_APPLICATION;

  beforeEach(() => {
    acquireLock.mockReset();
    scheduleRebuild.mockReset();
    scheduleRebuild.mockResolvedValue(undefined);
    delete process.env.VCAP_APPLICATION;
  });

  afterEach(() => {
    if (origVcap === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = origVcap;
  });

  describe('currentDeployVersion', () => {
    it('returns null when not on CF (no VCAP_APPLICATION)', () => {
      expect(currentDeployVersion()).toBeNull();
    });

    it('extracts application_version from VCAP_APPLICATION', () => {
      process.env.VCAP_APPLICATION = VER_A;
      expect(currentDeployVersion()).toBe('aaaa-1111');
    });

    it('returns null on malformed VCAP_APPLICATION', () => {
      process.env.VCAP_APPLICATION = 'not-json';
      expect(currentDeployVersion()).toBeNull();
    });
  });

  it('skips (no dispatch) when there is no deploy version', async () => {
    const res = await selfHealOnDeploy();
    expect(res).toEqual({ triggered: false, reason: 'no-version' });
    expect(acquireLock).not.toHaveBeenCalled();
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  it('dispatches a catalog-only rebuild once when the sentinel is free', async () => {
    acquireLock.mockResolvedValue(true);
    const res = await selfHealOnDeploy({ version: 'aaaa-1111' });

    expect(res.triggered).toBe(true);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(acquireLock.mock.calls[0][0]).toBe('deploy-self-heal-aaaa-1111');
    expect(scheduleRebuild).toHaveBeenCalledTimes(1);
    expect(scheduleRebuild).toHaveBeenCalledWith('deploy-self-heal', { mode: 'catalog-only' });
  });

  it('skips dispatch when the sentinel is already held (crash-restart, same version)', async () => {
    acquireLock.mockResolvedValue(false);
    const res = await selfHealOnDeploy({ version: 'aaaa-1111' });

    expect(res).toEqual({ triggered: false, reason: 'already-triggered' });
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  it('dispatches again on a NEW deploy version (different sentinel name)', async () => {
    acquireLock.mockResolvedValue(true);
    await selfHealOnDeploy({ version: 'aaaa-1111' });
    await selfHealOnDeploy({ version: 'bbbb-2222' });

    expect(acquireLock.mock.calls[0][0]).toBe('deploy-self-heal-aaaa-1111');
    expect(acquireLock.mock.calls[1][0]).toBe('deploy-self-heal-bbbb-2222');
    expect(scheduleRebuild).toHaveBeenCalledTimes(2);
  });

  it('never throws when acquireLock rejects (fail-open)', async () => {
    acquireLock.mockRejectedValue(new Error('HANA down'));
    const res = await selfHealOnDeploy({ version: 'aaaa-1111' });

    expect(res).toEqual({ triggered: false, reason: 'error' });
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  it('never throws when scheduleRebuild rejects (fail-open)', async () => {
    acquireLock.mockResolvedValue(true);
    scheduleRebuild.mockRejectedValue(new Error('dispatch boom'));
    const res = await selfHealOnDeploy({ version: 'aaaa-1111' });

    expect(res).toEqual({ triggered: false, reason: 'error' });
  });

  it('reads application_version from the live env when version not passed', async () => {
    process.env.VCAP_APPLICATION = VER_B;
    acquireLock.mockResolvedValue(true);
    await selfHealOnDeploy();

    expect(acquireLock.mock.calls[0][0]).toBe('deploy-self-heal-bbbb-2222');
    expect(scheduleRebuild).toHaveBeenCalledTimes(1);
  });
});
