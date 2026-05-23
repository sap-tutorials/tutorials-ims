import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCfLogsUrl, resetConfigCache } from '../../srv/lib/cf-logs-link.js';

const VCAP_SERVICES_WITH_LOGGING = JSON.stringify({
  'cloud-logging': [{
    label: 'cloud-logging',
    name: 'tutorials-cloud-logging',
    credentials: {
      'dashboards-endpoint': 'dashboards-x.cls-21.cloud.logs.services.eu10.hana.ondemand.com'
    }
  }]
});

const VCAP_APPLICATION = JSON.stringify({ application_name: 'tutorials-srv' });

function withBinding() {
  process.env.VCAP_SERVICES    = VCAP_SERVICES_WITH_LOGGING;
  process.env.VCAP_APPLICATION = VCAP_APPLICATION;
  resetConfigCache();
}

function withoutBinding() {
  delete process.env.VCAP_SERVICES;
  delete process.env.VCAP_APPLICATION;
  resetConfigCache();
}

describe('buildCfLogsUrl', () => {
  let savedServices, savedApp;

  beforeEach(() => {
    savedServices = process.env.VCAP_SERVICES;
    savedApp      = process.env.VCAP_APPLICATION;
  });

  afterEach(() => {
    if (savedServices === undefined) delete process.env.VCAP_SERVICES;
    else process.env.VCAP_SERVICES = savedServices;
    if (savedApp === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = savedApp;
    resetConfigCache();
  });

  it('returns null when the cloud-logging binding is missing', () => {
    withoutBinding();
    const url = buildCfLogsUrl({
      startedAt: '2026-05-22T10:00:00.000Z',
      finishedAt: '2026-05-22T10:01:00.000Z'
    });
    expect(url).toBeNull();
  });

  it('returns null when VCAP_APPLICATION is missing', () => {
    process.env.VCAP_SERVICES = VCAP_SERVICES_WITH_LOGGING;
    delete process.env.VCAP_APPLICATION;
    resetConfigCache();
    const url = buildCfLogsUrl({ startedAt: '2026-05-22T10:00:00.000Z' });
    expect(url).toBeNull();
  });

  it('returns null when startedAt is missing', () => {
    withBinding();
    expect(buildCfLogsUrl({})).toBeNull();
    expect(buildCfLogsUrl({ startedAt: null })).toBeNull();
  });

  it('returns null for invalid timestamps', () => {
    withBinding();
    expect(buildCfLogsUrl({ startedAt: 'not-a-date' })).toBeNull();
    expect(buildCfLogsUrl({
      startedAt: '2026-05-22T10:00:00.000Z',
      finishedAt: 'garbage'
    })).toBeNull();
  });

  it('builds a dashboards URL with -10s/+30s padding around the run', () => {
    withBinding();
    const url = buildCfLogsUrl({
      startedAt: '2026-05-22T10:00:00.000Z',
      finishedAt: '2026-05-22T10:01:00.000Z'
    });
    expect(url).toMatch(/^https:\/\/dashboards-x\.cls-21\.cloud\.logs\.services\.eu10\.hana\.ondemand\.com\/app\/discover#\/\?_g=/);

    const u = new URL(url);
    const g = decodeURIComponent(u.hash.split('_g=')[1].split('&')[0]);
    expect(g).toContain("from:'2026-05-22T09:59:50.000Z'");
    expect(g).toContain("to:'2026-05-22T10:01:30.000Z'");

    const a = decodeURIComponent(u.hash.split('_a=')[1]);
    expect(a).toContain('language:kuery');
    expect(a).toContain('cf_app_name : "tutorials-srv"');
  });

  it('uses now()+30s as the upper bound when the run is still RUNNING', () => {
    withBinding();
    const before = Date.now();
    const url = buildCfLogsUrl({
      startedAt: '2026-05-22T10:00:00.000Z'
    });
    const after = Date.now();

    const g = decodeURIComponent(url.split('_g=')[1].split('&')[0]);
    const m = g.match(/to:'([^']+)'/);
    expect(m).not.toBeNull();
    const toMs = new Date(m[1]).getTime();
    expect(toMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(toMs).toBeLessThanOrEqual(after + 30_000);
  });

  it('re-reads binding on every call (no internal cache)', () => {
    withBinding();
    const a = buildCfLogsUrl({ startedAt: '2026-05-22T10:00:00.000Z', finishedAt: '2026-05-22T10:01:00.000Z' });
    expect(a).not.toBeNull();
    delete process.env.VCAP_SERVICES;
    const b = buildCfLogsUrl({ startedAt: '2026-05-22T10:00:00.000Z', finishedAt: '2026-05-22T10:01:00.000Z' });
    expect(b).toBeNull();
  });
});
