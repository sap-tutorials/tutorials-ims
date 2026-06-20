//
// Write-side handler for POST /api/ui-event — accepts batches of anonymous
// client-side telemetry from the browser tracker (PR 2). Behind UI_EVENTS_ENABLED
// env flag (dormant by default = 503). Validates payload, rejects oversized
// or malformed batches, INSERTs to UIEvent entity in HANA.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

import cds from '@sap/cds'
import { resolveUiEventsSettings } from './runtime-config/ui-events-settings.js'

const VALID_EVENT_TYPES = new Set([
  'page_view', 'filter_change', 'card_click', 'pagination_change',
  'rail_show_all_click', 'scroll_depth', 'page_leave', 'referred_view',
])

const VALID_SURFACES = new Set(['/', '/browse/', '/tutorials/'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAYLOAD_BYTES = 32 * 1024 // 32 KB defensive cap (pagehide sendBeacon hard limit is 64 KB)

let _state = {
  insertFn: defaultInsert,
}

async function defaultInsert(rows) {
  const db = await cds.connect.to('db')
  const { UIEvent } = cds.entities('com.sap.developers.ims')
  return db.run(INSERT.into(UIEvent).entries(rows))
}

export function _resetForTests({ insertFn }) {
  _state.insertFn = insertFn ?? defaultInsert
}

export function checkFeatureFlag() {
  console.log('[ui-event] UI events handler loaded. Feature flag resolved per-request from UiEventsSettings + env var fallback.')
}

export function validateBatch(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'body must be a JSON object' }
  }
  if (typeof body.sessionId !== 'string' || !UUID_RE.test(body.sessionId)) {
    return { ok: false, reason: 'sessionId must be a UUID v4' }
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return { ok: false, reason: 'events must be a non-empty array' }
  }
  // Defensive: cap total batch JSON size
  const jsonSize = Buffer.byteLength(JSON.stringify(body.events), 'utf8')
  if (jsonSize > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `events JSON exceeds 32 KB limit (got ${jsonSize})` }
  }
  for (const ev of body.events) {
    if (!ev || typeof ev !== 'object') {
      return { ok: false, reason: 'each event must be an object' }
    }
    if (!VALID_EVENT_TYPES.has(ev.eventType)) {
      return { ok: false, reason: `unknown eventType: ${ev.eventType}` }
    }
    if (!VALID_SURFACES.has(ev.surface)) {
      return { ok: false, reason: `unknown surface: ${ev.surface}` }
    }
    if (typeof ev.timestamp !== 'number' || ev.timestamp <= 0) {
      return { ok: false, reason: 'timestamp must be a positive number' }
    }
    // payload may be undefined (no required-fields check at handler level — too brittle)
  }
  return { ok: true }
}

export async function handleUIEvent(req, res) {
  const { enabled } = await resolveUiEventsSettings()
  if (!enabled) {
    return res.status(503).json({ error: 'ui-events disabled' })
  }

  const validation = validateBatch(req.body)
  if (!validation.ok) {
    return res.status(400).json({ error: validation.reason })
  }

  const { sessionId, events } = req.body
  const userAgent = (req.headers?.['user-agent'] ?? '').slice(0, 512)
  const buildAt = req.body.buildAt ?? ''

  const rows = events.map(ev => ({
    sessionId,
    surface: ev.surface,
    eventType: ev.eventType,
    timestamp: new Date(ev.timestamp).toISOString(),
    payload: JSON.stringify(ev.payload ?? {}),
    userAgent,
    buildAt,
  }))

  try {
    await _state.insertFn(rows)
    return res.status(204).end()
  } catch (err) {
    console.error('[ui-event] insert failed:', err.message ?? err)
    return res.status(500).json({ error: 'insert failed' })
  }
}
