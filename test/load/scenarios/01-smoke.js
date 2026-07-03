// test/load/scenarios/01-smoke.js
// 1 VU × 30 s. One hit per endpoint class. Verifies the harness is wired
// (env vars resolve, setup() fetches slugs, WebSocket handshake completes).

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkJson, checkHtml, checkImage } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { scenario: 'smoke' },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  return fetchSlugs(SRV_URL);
}

export default function (data) {
  const slug = data.tutorialSlugs[0];

  checkJson(getTagged(`${SRV_URL}/build/catalog`, 'build-catalog'), 'build-catalog');
  checkJson(getTagged(`${SRV_URL}/build/navigator`, 'build-navigator'), 'build-navigator');
  checkHtml(getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial'), 'tutorial');
  checkJson(getTagged(`${SRV_URL}/api/advocates`, 'advocates-list'), 'advocates-list');
  if (data.advocateSlugs.length > 0) {
    checkImage(
      getTagged(
        `${SRV_URL}/api/advocates/${data.advocateSlugs[0]}/photo`,
        'advocates-photo',
      ),
      'advocates-photo',
      'image/',
    );
  }

  sleep(1);
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2), stdout: textSummary(data) };
}

// Minimal stdout summary — k6 no longer ships handleSummary defaults in 0.51.
function textSummary(data) {
  const m = data.metrics;
  const p95 = (name) =>
    m[name] && m[name].values && m[name].values['p(95)']
      ? `${m[name].values['p(95)'].toFixed(1)}ms`
      : 'n/a';
  return `smoke: http_req_duration p95=${p95('http_req_duration')} errors=${m.http_req_failed?.values?.rate?.toFixed(4) ?? 'n/a'}\n`;
}
