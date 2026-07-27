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
      // `mode` is a real threshold dimension; the `scenario` dimension comes
      // from the scenario key (`tutorialServe`) via k6's system tag — a custom
      // `scenario` tag would NOT override it, so we don't set one.
      tags: { mode: MODE },
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
  // k6 0.51.0's Babel transpiler lacks object spread; use Object.assign.
  return Object.assign({}, slugs, { hotSlugs: hotSlugs });
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
