import cds from '@sap/cds';

const LOG = cds.log('mcp-events-search');

// Community-event taxonomy (see db/external-content.cds CommunityEvents).
const VALID_EVENT_TYPES = new Set(['codejam', 'teched', 'devtoberfest', 'usergroup']);
const VALID_REGIONS = new Set(['AMERICAS', 'EMEA', 'APJ']); // VIRTUAL/ALL handled separately

/** Map a CommunityEvents row to the MCP `search_events` wire shape. */
export function mapEventRow(e) {
  return {
    slug:        e.slug || '',
    title:       e.title || '',
    eventType:   e.eventType || '',
    description: e.description || '',
    location:    e.location || '',
    region:      e.region || 'UNKNOWN',
    isVirtual:   e.virtualOrInPerson === 'virtual',
    startDate:   e.startDate || null,
    endDate:     e.endDate || null,
    url:         e.url || null,
  };
}

/**
 * MCP curated tool handler: search the public CommunityEvents catalog.
 *
 * Anonymous surface — every caller-controlled input is validated/clamped, and
 * the whole thing fails open (returns []) so a DB hiccup never 500s an MCP
 * client. Reuses the region-filter semantics of homepage-service.js
 * `_codejamsForRegion` (#1030).
 */
export async function handleSearchEvents(req) {
  const d = req.data ?? {};
  const query = typeof d.query === 'string' ? d.query.trim() : '';
  const eventType = typeof d.eventType === 'string' ? d.eventType.trim().toLowerCase() : '';
  const region = typeof d.region === 'string' ? d.region.trim().toUpperCase() : 'ALL';
  const upcomingOnly = d.upcomingOnly !== false; // default true
  const limit = Math.min(Math.max(Number(d.limit) || 20, 1), 50);

  try {
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    const nowIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (startDate/endDate are DATE)

    // `1 = 1` seed lets every subsequent predicate use `.and` uniformly, so the
    // "no filters at all" path still produces a valid WHERE. Works on SQLite + HANA.
    let q = SELECT.from(CommunityEvents)
      .columns('slug', 'title', 'eventType', 'description', 'location',
               'region', 'virtualOrInPerson', 'startDate', 'endDate', 'url')
      .where`1 = 1`;

    if (upcomingOnly) {
      // Include in-progress multi-day events: not-yet-ended, or (no endDate and
      // starting today-or-later). coalesce() is avoided for cross-dialect safety.
      q = q.and`(endDate >= ${nowIso} or (endDate is null and startDate >= ${nowIso}))`;
    }
    if (eventType && VALID_EVENT_TYPES.has(eventType)) {
      q = q.and`eventType = ${eventType}`;
    }
    if (region === 'VIRTUAL') {
      q = q.and`virtualOrInPerson = ${'virtual'}`;
    } else if (region !== 'ALL' && VALID_REGIONS.has(region)) {
      q = q.and`region = ${region}`;
    }
    if (query) {
      const like = `%${query.toLowerCase()}%`;
      q = q.and`(lower(title) like ${like} or lower(description) like ${like})`;
    }

    q = q.orderBy('startDate asc').limit(limit);

    const rows = await cds.db.run(q);
    return (rows ?? []).map(mapEventRow);
  } catch (err) {
    LOG.warn('search_events failed:', err.message);
    return [];
  }
}
