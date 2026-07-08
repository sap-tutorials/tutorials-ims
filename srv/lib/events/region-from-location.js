// srv/lib/events/region-from-location.js
//
// Issue #1030 — derive homepage-band region (AMERICAS/EMEA/APJ/UNKNOWN) from
// the free-form `CommunityEvents.location` string. Case-insensitive substring
// match on ordered rules; first match wins. `virtual` sentinel returns UNKNOWN
// because region is orthogonal to virtuality (a virtual event has no region;
// its virtualness is tracked on `virtualOrInPerson` separately).
//
// Ordered by specificity: cities before countries before region terms, so
// "Berlin Americas Center" resolves to EMEA (city wins), not AMERICAS.
//
// Rules cover the ~50 most-common CodeJam locations plus SAP-hub cities.
// New unrecognized locations surface via the `homepage.events.region_unknown`
// metric so we can grow the ruleset in follow-up PRs.

const RULES = [
  // ── Tier 1: cities (all regions) ─────────────────────────────────────────
  // City rules run first so that "Berlin Americas Center" → EMEA (city wins),
  // not AMERICAS (region term "Americas" would fire if countries ran earlier).

  // AMERICAS cities
  { pattern: /\b(New York|San Francisco|Chicago|Toronto|Vancouver|Montreal|São Paulo|Sao Paulo|Buenos Aires|Mexico City|Boston|Seattle|Palo Alto|Austin|Atlanta|Miami)\b/i, region: 'AMERICAS' },
  // EMEA cities
  { pattern: /\b(Berlin|Munich|Hamburg|Frankfurt|Cologne|Walldorf|London|Manchester|Edinburgh|Paris|Lyon|Amsterdam|Rotterdam|Zurich|Geneva|Vienna|Milan|Rome|Madrid|Barcelona|Lisbon|Porto|Warsaw|Copenhagen|Stockholm|Oslo|Helsinki|Dublin|Prague|Budapest|Athens|Cape Town|Johannesburg|Tel Aviv|Jerusalem|Dubai|Riyadh|Cairo|Istanbul)\b/i, region: 'EMEA' },
  // APJ cities
  { pattern: /\b(Bangalore|Bengaluru|Mumbai|Delhi|New Delhi|Chennai|Hyderabad|Pune|Kolkata|Shanghai|Beijing|Shenzhen|Guangzhou|Hong Kong|Tokyo|Osaka|Kyoto|Yokohama|Sydney|Melbourne|Brisbane|Perth|Auckland|Wellington|Seoul|Busan|Taipei|Kuala Lumpur|Jakarta|Bangkok|Manila|Ho Chi Minh|Hanoi)\b/i, region: 'APJ' },

  // ── Tier 2: countries + region terms ─────────────────────────────────────
  // AMERICAS countries + region terms
  { pattern: /\b(USA|U\.S\.A\.|United States|U\.S\.|Canada|Mexico|Brazil|Argentina|Chile|Colombia|Peru|Americas)\b/i, region: 'AMERICAS' },
  // EMEA countries + region terms
  { pattern: /\b(Germany|France|UK|U\.K\.|United Kingdom|Britain|England|Scotland|Ireland|Netherlands|Belgium|Luxembourg|Switzerland|Austria|Italy|Spain|Portugal|Poland|Czech|Czechia|Hungary|Denmark|Sweden|Norway|Finland|Iceland|Greece|South Africa|Israel|UAE|Saudi Arabia|Egypt|Turkey|Morocco|Kenya|Nigeria|EMEA|Europe|European)\b/i, region: 'EMEA' },
  // APJ countries + region terms
  { pattern: /\b(India|China|Japan|Singapore|Australia|New Zealand|South Korea|Korea|Malaysia|Indonesia|Thailand|Vietnam|Philippines|Taiwan|APJ|APAC|Asia|Asia[- ]Pacific)\b/i, region: 'APJ' },
];

export function regionFromLocation(location) {
  if (location === null || location === undefined) return 'UNKNOWN';
  const s = String(location).trim();
  if (!s) return 'UNKNOWN';
  // 'virtual' sentinel — region is orthogonal to virtuality.
  if (/^virtual$/i.test(s)) return 'UNKNOWN';

  for (const rule of RULES) {
    if (rule.pattern.test(s)) return rule.region;
  }
  return 'UNKNOWN';
}
