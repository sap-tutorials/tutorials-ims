// srv/jobs/refresh-community-events-job.js
//
// Issue #1030 (Row 3 homepage events auto-pull): every 6 h, re-pull CodeJam +
// Devtoberfest metadata from Khoros / RSS into CommunityEvents. Does NOT do
// embedding or LLM concept extraction — those stay with the twice-weekly
// fetch-community-events-job.js. Purpose: keep the homepage events band
// fresh without incurring LLM cost on every cycle.
//
// Deliberate non-touching (memory: "Never depend on shared columns without
// reading the owner"): contentHash, lastExtractedHash, and
// CommunityEventConceptLinks are ALL owned by the twice-weekly extraction
// job. Leaving them alone here lets the two jobs be idempotent on the same
// rows — a new row upserted here (with contentHash=NULL) is naturally picked
// up by the twice-weekly job on its next cycle.
//
// Spec: docs/superpowers/specs/2026-07-07-1030-homepage-codejams-autopull-design.md §5

import cds from '@sap/cds';
import { fetchAllEvents, canonicalizeEventSlug } from '../lib/events/index.js';
import { decodeHtmlEntities } from '../lib/events/text-normalize.js';
import { regionFromLocation } from '../lib/events/region-from-location.js';
import * as metrics from '../lib/metrics.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const REFRESH_TYPES = ['codejam', 'devtoberfest'];
const LOG = cds.log('refresh-community-events');

export async function runRefreshCommunityEvents(_logId, opts = {}) {
  const fetchAllEventsFn = opts.fetchAllEvents ?? fetchAllEvents;
  const summary = { fetched: 0, upserted: 0, unknownRegion: 0, errors: 0 };
  try {
    const db = cds.db ?? await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);

    let orchResult;
    try {
      orchResult = await fetchAllEventsFn({
        now: new Date(),
        typesAllowlist: REFRESH_TYPES,
      });
    } catch (err) {
      LOG.error(`fetcher failed: ${err.message}`);
      summary.errors++;
      metrics.counter(`homepage.events.refresh[result=failed]`);
      return summary;
    }
    const { rows: corpus, perSource } = orchResult;
    summary.fetched = corpus.length;

    if (corpus.length === 0) {
      LOG.warn('refresh-community-events: fetchers returned no rows');
      metrics.counter(`homepage.events.refresh[result=partial]`);
      return summary;
    }

    const now = new Date();
    for (const row of corpus) {
      try {
        const slug = canonicalizeEventSlug(row.id);
        const title = decodeHtmlEntities(row.title ?? '');
        const location = decodeHtmlEntities(row.location ?? '');
        const virtualOrInPerson =
          (location && location.toLowerCase() === 'virtual') || row.scope === 'virtual'
            ? 'virtual' : 'in-person';
        const region = regionFromLocation(location);
        if (region === 'UNKNOWN' && virtualOrInPerson !== 'virtual') {
          summary.unknownRegion++;
          metrics.counter(`homepage.events.region_unknown[location=${encodeURIComponent(location)}]`);
        }

        const upsertRow = {
          slug,
          eventType: row.type,
          source: row._source ?? null,
          title,
          url: row.url,
          sourceId: row.id,
          location: location || '',
          scope: row.scope ?? '',
          virtualOrInPerson,
          region,
          startDate: row.date,
          endDate: row.end_date || null,
          lastSeenAt: now,
        };

        const existing = await SELECT.one.from(CommunityEvents).columns('ID').where({ slug });
        if (!existing) {
          await INSERT.into(CommunityEvents).entries({ ...upsertRow, firstSeenAt: now });
          metrics.counter(`homepage.events.refresh_rows[action=inserted]`);
        } else {
          await UPDATE(CommunityEvents).set(upsertRow).where({ ID: existing.ID });
          metrics.counter(`homepage.events.refresh_rows[action=updated]`);
        }
        summary.upserted++;
      } catch (err) {
        LOG.warn(`[${row.id}] refresh row error: ${err.message}`);
        summary.errors++;
      }
    }

    const result = summary.errors === 0 ? 'ok' : 'partial';
    metrics.counter(`homepage.events.refresh[result=${result}]`);
    LOG.info(JSON.stringify({ ...summary, perSource }));
    return summary;
  } catch (err) {
    LOG.error(`refresh cycle failed: ${err.message}`);
    summary.errors++;
    metrics.counter(`homepage.events.refresh[result=failed]`);
    return summary;
  }
}
