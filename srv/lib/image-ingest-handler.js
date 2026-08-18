// srv/lib/image-ingest-handler.js
//
// Express handler for POST /content/image?u=<encoded-source-url>&slug=&channel=
//
// Accepts the raw image BYTES in the request body (Content-Type = the image's
// mime type) and writes them to image-store. This is the "push" counterpart to
// the fetch-based self-heal in image-source-handler.js.
//
// Why bytes-in instead of the srv fetching GitHub itself: the tutorials-srv CF
// egress IP is flagged by GitHub's anonymous raw CDN (anonymous requests →
// 404), and no runtime GitHub token is provisioned on the srv. So the store is
// populated by whoever DOES have GitHub access — the publish step on a
// workstation/CI runner (scripts/backfill-images.ts) — which fetches each
// image and POSTs the bytes here. The approuter keeps its fail-open GitHub
// fetch as the serve-time safety net.
//
// Registered in srv/server.js as:
//   app.post('/content/image', contentAuthMiddleware,
//            express.raw({ type: '*/*', limit: '25mb' }), imageIngestHandler)
//
// Auth: CONTENT_API_KEY via contentAuthMiddleware (same as /content/publish).

import cds from '@sap/cds'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { channelFor } from './image-warm-utils.js'

const require = createRequire(import.meta.url)
const imageStore = require('./image-store.cjs')

const LOG = cds.log('image-ingest')

// Mirror of the ingest cap so a client can't push an oversized blob past the
// 25 MB body limit express.raw already enforces (defensive, cheap).
const MAX_IMAGE_BYTES = Number(process.env.IMG_MAX_BYTES) || 25 * 1024 * 1024

/**
 * POST /content/image — persist client-supplied image bytes.
 *
 * 200 — { action: 'stored' | 'unchanged', contentHash }
 * 400 — missing `u`, empty body, or oversized.
 * 500 — store write failed.
 */
export async function imageIngestHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })

  const buffer = req.body
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: 'Empty body' })
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Image too large' })
  }

  const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
  const channel = typeof req.query.channel === 'string' && req.query.channel
    ? req.query.channel
    : channelFor(u)
  const mimeType = req.get('content-type') || 'application/octet-stream'
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')

  try {
    const existing = await imageStore.head(u)
    if (existing.exists && existing.contentHash === contentHash) {
      return res.status(200).json({ action: 'unchanged', contentHash })
    }
    await imageStore.put(u, { buffer, mimeType, contentHash, slug, channel })
    return res.status(200).json({ action: 'stored', contentHash })
  } catch (err) {
    LOG.error('[image-ingest] store put failed for', u, '-', err.message)
    return res.status(500).json({ error: 'store write failed' })
  }
}
