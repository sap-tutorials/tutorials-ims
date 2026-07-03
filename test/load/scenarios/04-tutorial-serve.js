// test/load/scenarios/04-tutorial-serve.js
// 50 VU × 3 min hammering /tutorials/{slug}. LOAD_MODE=hot|cold (default cold).
// Isolates the HANA BLOB decompress + LRU cache path.

import { sleep } from 'k6';
import { BASE_URL, SRV_URL, SUMMARY_PATH, MODE, THRESHOLDS } from '../config.js';
import { getTagged } from '../lib/http.js';
import { checkHtml } from '../lib/checks.js';
import fetchSlugs from '../lib/slugs.js';

export const options = {
  scenarios: {
    tutorialServe: {
      executor: 'constant-vus',
      vus: 50,
      duration: '3m',
      tags: { scenario: 'tutorial-serve', mode: MODE },
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  const slugs = fetchSlugs(SRV_URL);
  // Hot mode: pick 10 fixed slugs at setup, share across all VUs.
  const hotSlugs =
    MODE === 'hot'
      ? slugs.tutorialSlugs.slice(0, Math.min(10, slugs.tutorialSlugs.length))
      : null;
  return { ...slugs, hotSlugs };
}

export default function (data) {
  let slug;
  if (MODE === 'hot') {
    slug = data.hotSlugs[Math.floor(Math.random() * data.hotSlugs.length)];
  } else {
    slug = data.tutorialSlugs[Math.floor(Math.random() * data.tutorialSlugs.length)];
  }
  checkHtml(
    getTagged(`${BASE_URL}/tutorials/${slug}/`, 'tutorial', {
      tags: { mode: MODE },
    }),
    'tutorial',
  );
  sleep(0.1 + Math.random() * 0.2);
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
