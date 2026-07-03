// test/load/scenarios/02-public-baseline.js
// 10 VU × 2 min. Weighted endpoint mix — see spec section 2.
// Weights: catalog 20 / navigator 10 / tutorial 50 / advocates-list 15 / advocates-photo 5.

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkJson, checkHtml, checkImage } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      tags: { scenario: 'baseline' },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  return fetchSlugs(SRV_URL);
}

// Weighted picker: cumulative-probability table. `roll` is [0, 100).
const MIX = [
  { max: 20, endpoint: 'build-catalog' },
  { max: 30, endpoint: 'build-navigator' },
  { max: 80, endpoint: 'tutorial' },
  { max: 95, endpoint: 'advocates-list' },
  { max: 100, endpoint: 'advocates-photo' },
];

function pickEndpoint() {
  const roll = Math.random() * 100;
  for (const m of MIX) {
    if (roll < m.max) return m.endpoint;
  }
  return MIX[MIX.length - 1].endpoint;
}

export default function (data) {
  const which = pickEndpoint();
  switch (which) {
    case 'build-catalog':
      checkJson(getTagged(`${SRV_URL}/build/catalog`, 'build-catalog'), 'build-catalog');
      break;
    case 'build-navigator':
      checkJson(getTagged(`${SRV_URL}/build/navigator`, 'build-navigator'), 'build-navigator');
      break;
    case 'tutorial': {
      const slug = data.tutorialSlugs[Math.floor(Math.random() * data.tutorialSlugs.length)];
      checkHtml(getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial'), 'tutorial');
      break;
    }
    case 'advocates-list':
      checkJson(getTagged(`${SRV_URL}/api/advocates`, 'advocates-list'), 'advocates-list');
      break;
    case 'advocates-photo': {
      if (data.advocateSlugs.length === 0) break;
      const slug = data.advocateSlugs[Math.floor(Math.random() * data.advocateSlugs.length)];
      checkImage(
        getTagged(`${SRV_URL}/api/advocates/${slug}/photo`, 'advocates-photo'),
        'advocates-photo',
        'image/',
      );
      break;
    }
  }
  sleep(0.3 + Math.random() * 0.4); // 300–700 ms think time
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
