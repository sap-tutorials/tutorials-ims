// srv/lib/help-docs/help-sap-com-fetcher.js
//
// Phase 4.7 (#748): help.sap.com narrative-docs fetcher.
// Two-step per-deliverable walk against help.sap.com's internal /http.svc/* API:
//   1. GET /http.svc/deliverableMetadata  → { deliverable: { id, buildNo }, filePath }
//   2. GET /http.svc/pagecontent          → { deliverable: { fullToc }, body, currentPage }
// The fullToc from the landing pagecontent call enumerates every topic in the
// deliverable; we then fetch pagecontent once per topic (with cached id + buildNo
// from the metadata call, valid for the duration of this cron cycle).
//
// Filter rules (spec §4.2.2):
//   - HTTP 200 required on both endpoints AND status === 'OK'
//   - Stripped body >= 200 chars
//   - Title non-empty
//   - Per-deliverable failure is survivable (log + skip; other ~19 deliverables continue)
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.2

const SYM = Symbol.for('com.sap.developers.ims.help-sap-com-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const METADATA_BASE = 'https://help.sap.com/http.svc/deliverableMetadata';
const PAGECONTENT_BASE = 'https://help.sap.com/http.svc/pagecontent';
const DOC_URL_BASE = 'https://help.sap.com/docs';
const URL_QUERY_SUFFIX = '?locale=en-US&state=PRODUCTION&version=Cloud';
const PER_PAGE_TIMEOUT_MS = 30_000;
const DESCRIPTION_MAX_CHARS = 2000;
const MIN_BODY_CHARS = 200;

// Deliverable scope. Seeded from db/data/com.sap.developers.ims-HomepageShelves.csv
// by grepping URLs starting `https://help.sap.com/docs/<product>` and picking the
// corresponding deliverable slug. Edit + redeploy to add/remove.
// Per spec §4.2.2.
export const HELP_SAP_COM_DELIVERABLES = Object.freeze([
  { product: 'btp', deliverable: 'sap-business-technology-platform' },
  { product: 'btp', deliverable: 'sap-btp-cloud-management-tools---overview' },
  { product: 'btp', deliverable: 'btp-developers-guide' },
  { product: 'abap-cloud', deliverable: 'abap-cloud' },
  { product: 'hana-cloud', deliverable: 'sap-hana-cloud' },
  { product: 'integration-suite', deliverable: 'sap-integration-suite' },
  { product: 'sap-build', deliverable: 'sap-build' },
  { product: 'joule', deliverable: 'sap-joule' },
  { product: 'ai-core', deliverable: 'sap-ai-core' },
  { product: 'ai-launchpad', deliverable: 'sap-ai-launchpad' },
  { product: 'destination-service', deliverable: 'sap-destination-service' },
  { product: 'connectivity', deliverable: 'sap-connectivity-service' },
  { product: 'event-mesh', deliverable: 'sap-event-mesh' },
  { product: 'business-application-studio', deliverable: 'sap-business-application-studio' },
  { product: 'work-zone', deliverable: 'sap-build-work-zone' },
  { product: 'mobile-services', deliverable: 'sap-mobile-services' },
  { product: 'btp-cli', deliverable: 'sap-btp-command-line-interface-btp-cli' },
  { product: 'identity-authentication', deliverable: 'identity-authentication' },
  { product: 'authorization-and-trust-management', deliverable: 'sap-authorization-and-trust-management-service' },
  { product: 'cloud-foundry-environment', deliverable: 'cloud-foundry-environment' },
]);

export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

/**
 * @typedef {Object} HelpDocRow
 * @property {'help-sap-com'} source
 * @property {string} sourceId       — '<product>/<deliverable>/<file_path-without-.html>'
 * @property {string} title
 * @property {string} description    — stripped body first 2000 chars
 * @property {string} url            — canonical human-readable help.sap.com URL
 * @property {string} product
 * @property {string|null} section   — immediate parent TOC entry title, or null
 */

/**
 * Fetch narrative-docs pages across the deliverable scope.
 * Per-deliverable failures are logged and skipped; partial catalog is preferred
 * over cycle-abort (chassis-standard behavior).
 *
 * @param {Object} [opts]
 * @param {Array<{product:string, deliverable:string}>} [opts.deliverables]  override for tests
 * @param {Set<string>} [opts.seenSourceIds]
 * @param {number} [opts.limit]
 * @returns {Promise<HelpDocRow[]>}
 */
export async function fetchHelpSapComCorpus({
  deliverables = HELP_SAP_COM_DELIVERABLES,
  seenSourceIds = null,
  limit = null,
} = {}) {
  const rows = [];

  for (const { product, deliverable } of deliverables) {
    if (limit != null && rows.length >= limit) break;

    // Step 1: deliverableMetadata — one call per deliverable per cycle.
    let meta;
    try {
      meta = await fetchDeliverableMetadata({ product, deliverable });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('help-sap-com-fetcher: metadata fetch failed', {
        product, deliverable, status: err && err.status, message: err && err.message,
      });
      continue;
    }
    if (!meta || meta.status !== 'OK' || !meta.data?.deliverable?.id) {
      // eslint-disable-next-line no-console
      console.warn('help-sap-com-fetcher: metadata non-OK', {
        product, deliverable, status: meta && meta.status,
      });
      continue;
    }

    const deliverableId = meta.data.deliverable.id;
    const buildNo = meta.data.deliverable.buildNo;
    const landingPath = meta.data.filePath;

    // Step 2: landing pagecontent — gives us fullToc + landing body in one call.
    let landing;
    try {
      landing = await fetchPageContent({ deliverableId, buildNo, filePath: landingPath });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('help-sap-com-fetcher: landing pagecontent failed', {
        product, deliverable, status: err && err.status,
      });
      continue;
    }
    if (!landing || landing.status !== 'OK') continue;

    const fullToc = Array.isArray(landing.data?.deliverable?.fullToc) ? landing.data.deliverable.fullToc : [];

    // Walk the TOC tree. Each node carries { t, u, c, parentTitle }.
    for (const node of walkToc(fullToc, null)) {
      if (limit != null && rows.length >= limit) break;
      if (!node.t || node.t.length === 0) continue;
      if (!node.u) continue;

      const sourceId = `${product}/${deliverable}/${stripDotHtml(node.u)}`;
      if (seenSourceIds && seenSourceIds.has(sourceId)) continue;

      // Landing body already fetched — reuse it. Otherwise per-topic pagecontent call.
      let bodyHtml;
      let topicReadableUrl = null;
      try {
        if (node.u === landingPath) {
          bodyHtml = landing.data.body;
          topicReadableUrl = landing.data.currentPage?.readableUrls?.topicReadableUrl || null;
        } else {
          const page = await fetchPageContent({ deliverableId, buildNo, filePath: node.u });
          if (!page || page.status !== 'OK') continue;
          bodyHtml = page.data?.body;
          topicReadableUrl = page.data?.currentPage?.readableUrls?.topicReadableUrl || null;
        }
      } catch {
        continue;   // per-topic 404 or timeout — skip
      }

      const stripped = stripHtml(bodyHtml);
      if (stripped.length < MIN_BODY_CHARS) continue;

      // URL construction: prefer the metadata-provided readable URL; fall back to slug from file_path.
      const topicSlug = topicReadableUrl || stripDotHtml(node.u).split('/').pop();
      const url = `${DOC_URL_BASE}/${product}/${deliverable}/${topicSlug}${URL_QUERY_SUFFIX}`;

      rows.push({
        source: 'help-sap-com',
        sourceId,
        title: node.t,
        description: stripped.slice(0, DESCRIPTION_MAX_CHARS),
        url,
        product,
        section: node.parentTitle,
      });
    }
  }

  return rows;
}

// Recursively walk the fullToc tree. Yields flat nodes annotated with parentTitle
// (immediate-parent TOC title, or null if top-level).
function* walkToc(nodes, parentTitle) {
  for (const n of nodes) {
    yield { t: n.t, u: n.u, parentTitle };
    if (Array.isArray(n.c) && n.c.length > 0) {
      yield* walkToc(n.c, n.t);
    }
  }
}

async function fetchDeliverableMetadata({ product, deliverable }) {
  const qs = new URLSearchParams({
    product_url: product,
    topic_url: deliverable,
    version: 'Cloud',
    deliverable_url: deliverable,
    language: 'en-US',
    state: 'PRODUCTION',
  });
  const url = `${METADATA_BASE}?${qs.toString()}`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`help.sap.com deliverableMetadata ${res.status} for ${product}/${deliverable}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchPageContent({ deliverableId, buildNo, filePath }) {
  const qs = new URLSearchParams({
    deliverable_id: String(deliverableId),
    buildNo: String(buildNo),
    file_path: filePath,
  });
  const url = `${PAGECONTENT_BASE}?${qs.toString()}`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`help.sap.com pagecontent ${res.status} for ${filePath}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function stripDotHtml(p) {
  return String(p || '').replace(/\.html$/i, '');
}

function stripHtml(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
