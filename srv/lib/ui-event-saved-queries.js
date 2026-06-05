// srv/lib/ui-event-saved-queries.js
//
// Canonical SavedQueries seeder for the / vs /browse/ A/B comparison (#204, PR 4).
//
// 6 read-only SQL queries pre-populated into AnalyticsSavedQuery on cds.served,
// idempotent (re-running is free). Each query maps to a question in the runbook
// (see docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md).
//
// All queries pass srv/lib/analytics-sql-validator.cjs (allowlisted aggregates +
// CASE WHEN sums, no FILTER/MEDIAN/PERCENTILE/CTE syntax). HANA reserved word
// `timestamp` is double-quoted; payload-keyed filters use LIKE (HANA + SQLite
// both support LIKE, no JSON_VALUE needed).
//
// Visibility: 'shared-admins' so the queries surface for every Admin user, not
// just the seeder's $user identity.

import cds from '@sap/cds'

const QUERIES = [
  {
    name: 'A/B — Daily sessions per surface',
    description:
      'Count of distinct anonymous tab-sessions that loaded each surface, per day. ' +
      'Read top-level by stakeholders to see traffic split between / and /browse/.',
    sql: `SELECT surface, CAST("TIMESTAMP" AS DATE) AS day, COUNT(DISTINCT sessionId) AS sessions
          FROM UIEvents
          WHERE eventType = 'page_view'
          GROUP BY surface, CAST("TIMESTAMP" AS DATE)
          ORDER BY day DESC, surface`,
  },
  {
    name: 'A/B — Filter usage rate per surface',
    description:
      'For each surface, total sessions and sessions that fired ≥1 filter_change event. ' +
      'Compute the ratio in the runbook (filter_sessions / total_sessions).',
    sql: `SELECT surface,
                 COUNT(DISTINCT sessionId) AS total_sessions,
                 COUNT(DISTINCT CASE WHEN eventType = 'filter_change' THEN sessionId END) AS filter_sessions
          FROM UIEvents
          GROUP BY surface
          ORDER BY surface`,
  },
  {
    name: 'A/B — Card click-through rate per surface',
    description:
      'Sessions that viewed the surface vs sessions that clicked any card. CTR = ' +
      'click_sessions / view_sessions. 95% CIs go in the runbook (Wald approximation).',
    sql: `SELECT surface,
                 COUNT(DISTINCT CASE WHEN eventType = 'page_view'  THEN sessionId END) AS view_sessions,
                 COUNT(DISTINCT CASE WHEN eventType = 'card_click' THEN sessionId END) AS click_sessions
          FROM UIEvents
          GROUP BY surface
          ORDER BY surface`,
  },
  {
    name: 'A/B — Time-to-first-click per surface',
    description:
      'Min/max/avg ms between first page_view and first card_click within a session. ' +
      'NOTE: median/percentiles not yet in the validator allowlist — eyeball avg vs max ' +
      'for skew, or export to CSV and percentile in a notebook.',
    sql: `SELECT surface,
                 MIN(click_ts - view_ts) AS min_ms,
                 MAX(click_ts - view_ts) AS max_ms,
                 AVG(click_ts - view_ts) AS avg_ms,
                 COUNT(*) AS sessions_observed
          FROM (
            SELECT sessionId, surface,
                   MIN(CASE WHEN eventType = 'page_view'  THEN "TIMESTAMP" END) AS view_ts,
                   MIN(CASE WHEN eventType = 'card_click' THEN "TIMESTAMP" END) AS click_ts
            FROM UIEvents
            GROUP BY sessionId, surface
          ) per_session
          WHERE view_ts IS NOT NULL AND click_ts IS NOT NULL AND click_ts >= view_ts
          GROUP BY surface
          ORDER BY surface`,
  },
  {
    name: 'A/B — Bounce rate per surface',
    description:
      'Sessions with a page_view but ZERO card_clicks, per surface. Bounce rate = ' +
      'bounced_sessions / view_sessions.',
    sql: `SELECT surface,
                 COUNT(*) AS view_sessions,
                 SUM(CASE WHEN clicks = 0 THEN 1 ELSE 0 END) AS bounced_sessions
          FROM (
            SELECT sessionId, surface,
                   SUM(CASE WHEN eventType = 'card_click' THEN 1 ELSE 0 END) AS clicks,
                   SUM(CASE WHEN eventType = 'page_view'  THEN 1 ELSE 0 END) AS views
            FROM UIEvents
            GROUP BY sessionId, surface
          ) per_session
          WHERE views > 0
          GROUP BY surface
          ORDER BY surface`,
  },
  {
    name: 'A/B — Search usage rate per surface',
    description:
      'Fraction of sessions that fired a filter_change with kind=search. payload is a ' +
      'JSON string column; we LIKE-match the literal {"kind":"search"} fragment (works on ' +
      'both HANA and SQLite without JSON_VALUE).',
    sql: `SELECT surface,
                 COUNT(DISTINCT sessionId) AS total_sessions,
                 COUNT(DISTINCT CASE WHEN eventType = 'filter_change' AND payload LIKE '%"kind":"search"%' THEN sessionId END) AS search_sessions
          FROM UIEvents
          GROUP BY surface
          ORDER BY surface`,
  },
]

/**
 * Idempotently seed the 6 canonical A/B saved queries.
 * @param {cds.DatabaseService} db
 * @returns {Promise<{inserted: number, total: number}>}
 */
async function seedUIEventSavedQueries(db) {
  const SavedQuery = 'com.sap.developers.ims.AnalyticsSavedQuery'
  const existing = await db.run(
    SELECT.from(SavedQuery).columns('name').where({ name: { in: QUERIES.map(q => q.name) } })
  )
  const existingNames = new Set(existing.map(r => r.name))
  const toInsert = QUERIES.filter(q => !existingNames.has(q.name))
  if (!toInsert.length) return { inserted: 0, total: QUERIES.length }
  const rows = toInsert.map(q => ({
    name: q.name,
    description: q.description,
    sql: q.sql,
    visibility: 'shared-admins',
    spec: '',                  // Phase-4 builder spec; empty for hand-authored canonical queries
    privacyMode: 'raw',
    createdBy: 'system',
  }))
  await db.run(INSERT.into(SavedQuery).entries(rows))
  return { inserted: toInsert.length, total: QUERIES.length }
}

export { seedUIEventSavedQueries, QUERIES }
