// test/unit/homepage-events-region-drift.test.js
// #1030 — server regionFromLocation and client tzToRegion must share the
// AMERICAS/EMEA/APJ output vocabulary. Inputs differ (location strings vs
// IANA zones), but the ENUM must not drift.

import { describe, it, expect } from 'vitest';
import { regionFromLocation } from '../../srv/lib/events/region-from-location.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('region output enum drift guard', () => {
  it('server + client output the same physical region names', () => {
    const serverOutputs = new Set([
      regionFromLocation('New York'),
      regionFromLocation('Berlin'),
      regionFromLocation('Tokyo'),
    ]);
    expect(serverOutputs).toEqual(new Set(['AMERICAS', 'EMEA', 'APJ']));

    const clientSrc = fs.readFileSync(
      path.resolve(__dirname, '../../hugo-apps/src/homepage-events-band/tz-to-region.ts'),
      'utf8',
    );
    // Fingerprint check: the same three region strings appear in the client's PREFIX_MAP.
    for (const r of ['AMERICAS', 'EMEA', 'APJ']) {
      expect(clientSrc.includes(`'${r}'`)).toBe(true);
    }
  });
});
