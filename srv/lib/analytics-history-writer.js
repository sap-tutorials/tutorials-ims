import cds from '@sap/cds'

const VALID_SOURCES = new Set(['builder', 'editor', 'joule', 'replay'])

export function normalizeSource(s) {
  if (typeof s !== 'string') return 'editor'
  return VALID_SOURCES.has(s) ? s : 'editor'
}

export async function writeHistoryRow({ user, sql, rowCount, durationMs, truncated, source }) {
  const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
  const ID = cds.utils.uuid()
  await INSERT.into(AnalyticsQueryHistory).entries({
    ID,
    spec: null,                    // Phase 1: builder not yet wired — Phase 2 will populate
    sql,
    rowCount,
    durationMs,
    truncated: !!truncated,
    privacyMode: 'raw',
    source: normalizeSource(source),
    createdBy: user,
    createdAt: new Date().toISOString(),
  })
  return ID
}
