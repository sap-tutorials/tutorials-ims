// srv/lib/rss-transport-mode.js
//
// Single source of truth for which transport the SAP Community RSS fetchers
// use. Shared by community-blogs-fetcher.js and homepage-rss-fetcher.js — they
// previously each carried an identical copy of rssMode(), which drifted risk.
//
// Tri-state transport (see khoros-transport.js / curl-transport.js):
//   'khoros' — unauthenticated Khoros LiQL JSON API (community.sap.com/api/2.0/search)
//   'curl'   — curl binary on the raw RSS feed (borrows a TLS fingerprint
//              Cloudflare passes; Node undici's ClientHello is JA3/JA4-flagged)
//   'fetch'  — native fetch on the raw RSS feed (local/tests only)
//
// Resolution order:
//   1. process.env.RSS_TRANSPORT, when set to a recognized value — an explicit
//      operator override and the mechanism every unit test relies on. 'fetch'
//      is ONLY reachable this way (test-only; never a DB-config outcome).
//   2. else the COMMUNITY_RSS_USE_CURL DB feature flag (ImsConfig key
//      flag.community.rss.useCurl, default true → 'curl'): the admin-toggleable
//      switch between the two production transports. Default is 'curl' because
//      Cloudflare now 403-challenges the Khoros API path (#<issue>), so 'curl'
//      on the still-open /rss/ feeds is the working transport.
//
// isFlagEnabled() is synchronous and fail-safe (returns the declared registry
// default on a cold/errored cache), so rssMode() stays synchronous and never
// throws — matching the fetchers' fail-open contract.

import { isFlagEnabled } from './feature-flags/db-flags.js';

export function rssMode() {
  const m = process.env.RSS_TRANSPORT;
  if (m === 'curl' || m === 'fetch' || m === 'khoros') return m;
  return isFlagEnabled('COMMUNITY_RSS_USE_CURL') ? 'curl' : 'khoros';
}
