// srv/lib/attachment-source-handler.js
//
// Express handler for GET /content/attachment-source?u=<encoded-source-url>&dl=<0|1>.
//
// Streams the stored attachment from attachment-store on a cache hit.
// On a miss, self-heals by calling ingestAttachment once (single-flight so
// concurrent misses for the same URL coalesce). Returns 404 if ingest
// also fails.
//
// Registered in srv/server.js as:
//   app.get('/content/attachment-source', attachmentSourceHandler)
//
// Anonymous — no auth required; public content like /content/tutorials/:slug.
// Sets Content-Disposition based on MIME type and optional ?dl=1 (force download).
// Analog of image-source-handler.js, plus disposition logic.

import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { safeFetch } from './safe-fetch.js'
import { resolveSecret } from './secret-resolver.js'
import { channelFor, warmAttachments } from './attachment-warm-utils.js'

const require = createRequire(import.meta.url)
const attachmentStore = require('./attachment-store.cjs')
const { ingestAttachment } = require('./attachment-ingest.cjs')
const { dispositionFor } = require('./attachment-mime.cjs')
const { fetchImageResponse } = require('./img-cdn-fetch.cjs')

const LOG = cds.log('attachment-source')

/** In-flight map: URL → Promise<ingestResult> for single-flight dedup. */
const _inflight = new Map()

/**
 * Warm the attachment store for `urls` referenced by tutorial `slug`.
 * Assembles the real ingestAttachment deps at module scope (attachmentStore,
 * fetchImageResponse, safeFetch, resolveSecret) and delegates to the
 * pure warmAttachments orchestrator from attachment-warm-utils.js.
 *
 * Non-fatal per URL: warmAttachments catches any throw or `failed` result and
 * logs it; this function always resolves.
 *
 * @param {string[]} urls
 * @param {{ slug: string }} opts
 * @returns {Promise<void>}
 */
export function warmAttachmentsLive(urls, { slug }) {
  const ingestFn = (url, { slug: s, channel }) =>
    ingestAttachment(url, {
      slug: s,
      channel,
      deps: { fetchImageResponse, safeFetch, resolveSecret, store: attachmentStore },
    })
  return warmAttachments(urls, { slug, ingestFn })
}

/**
 * Express handler for GET /content/attachment-source?u=<url>&dl=<0|1>.
 *
 * 200 — streams attachment bytes with Content-Type and Content-Disposition.
 * 400 — missing `u` query parameter.
 * 404 — attachment not in store and ingest self-heal also failed.
 *
 * Query params:
 *   u   — URL-encoded source URL (required)
 *   dl  — "1" or "true" forces attachment (download) disposition regardless of MIME type
 */
export async function attachmentSourceHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })

  const download = req.query.dl === '1' || req.query.dl === 'true'

  // Fast path: attachment already in store.
  let got = await attachmentStore.getStream(u)

  if (!got) {
    // Slow path: self-heal by fetching and storing the original.
    // Single-flight: coalesce concurrent misses for the same URL.
    let p = _inflight.get(u)
    if (!p) {
      const channel = channelFor(u)
      p = ingestAttachment(u, {
        slug: '',
        channel,
        deps: { fetchImageResponse, safeFetch, resolveSecret, store: attachmentStore },
      }).finally(() => _inflight.delete(u))
      _inflight.set(u, p)
    }

    let result = { action: 'failed' }
    try {
      result = await p
    } catch (err) {
      // ingestAttachment propagates throws from fetchImageResponse (e.g. SSRF_BLOCKED,
      // network errors). Treat any throw as a fetch failure → 404.
      LOG.warn('[attachment-source] self-heal ingest threw:', err.message)
    }

    if (result.action === 'failed') {
      return res.status(404).json({ error: 'Attachment unavailable' })
    }

    got = await attachmentStore.getStream(u)
    if (!got) return res.status(404).json({ error: 'Attachment unavailable' })
  }

  const filename = got.filename || String(u).split('/').pop() || 'file'
  const { contentType, disposition } = dispositionFor(
    got.mimeType || 'application/octet-stream',
    { download, filename }
  )

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', disposition)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('X-Content-Source', 'attachment-store')

  got.stream.on('error', (err) => {
    LOG.warn('[attachment-source] stream error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' })
  })
  got.stream.pipe(res)
}
