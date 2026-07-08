// hugo-apps/apps/homepage-events-band/src/tz-to-region.ts
//
// #1030 — Coarse IANA-timezone → homepage-region hint. Runs once on first
// mount for signed-out visitors, or signed-in visitors who never set
// preferredEventRegion. Deliberately loose — an incorrect hint just picks
// the wrong default chip; the user overrides with one click. Server side
// (srv/lib/events/region-from-location.js) is the source of truth for the
// actual `region` column on events; this file only picks a default UI chip.

export type Region = 'AMERICAS' | 'EMEA' | 'APJ' | 'VIRTUAL' | 'ALL';

const PREFIX_MAP: Array<[RegExp, Region]> = [
  [/^America\//,   'AMERICAS'],
  [/^US\//,        'AMERICAS'],
  [/^Canada\//,    'AMERICAS'],
  [/^Europe\//,    'EMEA'],
  [/^Africa\//,    'EMEA'],
  [/^Atlantic\//,  'EMEA'],
  [/^Asia\//,      'APJ'],
  [/^Australia\//, 'APJ'],
  [/^Pacific\//,   'APJ'],
  [/^Indian\//,    'APJ'],
];

export function tzToRegion(tz?: string): Region {
  const z = tz ?? (typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : '') ?? '';
  for (const [re, r] of PREFIX_MAP) if (re.test(z)) return r;
  return 'ALL';
}
