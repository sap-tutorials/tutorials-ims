// srv/lib/attachment-ingest-handler.js
//
// Express handler for POST /content/attachment?u=<encoded-source-url>&slug=&channel=&force=
//
// Accepts raw attachment BYTES in the request body and writes them to
// attachment-store. This is the "push" counterpart to the fetch-based
// self-heal in attachment-source-handler.js.
//
// Why bytes-in instead of the srv fetching GitHub itself: the tutorials-srv CF
// egress IP is flagged by GitHub's anonymous raw CDN (anonymous requests →
// 404), and no runtime GitHub token is provisioned on the srv. So the store is
// populated by whoever DOES have GitHub access — the publish step on a
// workstation/CI runner (scripts/backfill-images.ts) — which fetches each
// attachment and POSTs the bytes here.
//
// Registered in srv/server.js as (Task 11):
//   app.post('/content/attachment', contentAuthMiddleware,
//            express.raw({ type: '*/*', limit: '25mb' }), attachmentIngestHandler)
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (same as /content/publish).

import cds from '@sap/cds'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { channelFor } from './attachment-warm-utils.js'

const require = createRequire(import.meta.url)
const attachmentStore = require('./attachment-store.cjs')
const { extToMime } = require('./attachment-mime.cjs')

const LOG = cds.log('attachment-ingest')

// Mirror of the ingest cap so a client can't push an oversized blob past the
// 25 MB body limit express.raw already enforces (defensive, cheap).
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024

/**
 * POST /content/attachment — persist client-supplied attachment bytes.
 *
 * 200 — { action: 'stored' | 'unchanged', contentHash }
 * 400 — missing `u`, empty body, or oversized.
 * 500 — store write failed.
 */
export async function attachmentIngestHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })

  const buffer = req.body
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: 'Empty body' })
  }
  if (buffer.length > MAX_BYTES) {
    return res.status(400).json({ error: 'Attachment too large' })
  }

  const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
  const channel = typeof req.query.channel === 'string' && req.query.channel
    ? req.query.channel
    : channelFor(u)

  // Use the request Content-Type unless absent or generic octet-stream,
  // in which case fall back to extension-based MIME. This lets the push
  // client supply an accurate type while still working for unknown types.
  const reqCt = req.get('content-type') || ''
  const mimeType = (reqCt && reqCt !== 'application/octet-stream')
    ? reqCt
    : extToMime(u)

  const filename = String(u).split('/').pop()
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')

  // force=1 bypasses the hash dedup and always re-stores. Needed to heal
  // "orphaned" rows — metadata + matching hash present but content missing/
  // unretrievable (e.g. from an earlier put that inserted metadata then threw
  // before the object persisted). Without force those never re-store because
  // the unchanged short-circuit trusts the hash match. put() removes-then-
  // inserts, so a forced re-store cleans the orphan.
  const force = req.query.force === '1' || req.query.force === 'true'

  try {
    if (!force) {
      const existing = await attachmentStore.head(u)
      if (existing.exists && existing.contentHash === contentHash) {
        return res.status(200).json({ action: 'unchanged', contentHash })
      }
    }
    await attachmentStore.put(u, { buffer, mimeType, contentHash, slug, channel, filename })
    return res.status(200).json({ action: 'stored', contentHash })
  } catch (err) {
    LOG.error('[attachment-ingest] store put failed for', u, '-', err.message)
    return res.status(500).json({ error: 'store write failed' })
  }
}
