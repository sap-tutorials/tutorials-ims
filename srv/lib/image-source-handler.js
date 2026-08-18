// srv/lib/image-source-handler.js
//
// Express handler for GET /content/image-source?u=<encoded-source-url>.
//
// Streams the stored original image from image-store on a cache hit.
// On a miss, self-heals by calling ingestImage once (single-flight so
// concurrent misses for the same URL coalesce). Returns 404 if ingest
// also fails.
//
// Registered in srv/server.js as:
//   app.get('/content/image-source', imageSourceHandler)
//
// Anonymous — no auth required; public content like /content/tutorials/:slug.
// The approuter will use this endpoint to serve originals instead of forwarding
// raw GitHub URLs to the browser.

import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { safeFetch } from './safe-fetch.js'
import { resolveSecret } from './secret-resolver.js'
import { channelFor, warmImages } from './image-warm-utils.js'

export { channelFor } from './image-warm-utils.js'
export { extractImgCdnUrls } from './image-warm-utils.js'

const require = createRequire(import.meta.url)
const imageStore = require('./image-store.cjs')
const { ingestImage } = require('./image-ingest.cjs')
const { fetchImageResponse } = require('./img-cdn-fetch.cjs')

const LOG = cds.log('image-source')

/** In-flight map: URL → Promise<ingestResult> for single-flight dedup. */
const _inflight = new Map()

/**
 * Warm the image store for `urls` referenced by tutorial `slug`.
 * Assembles the real ingestImage deps at module scope (imageStore,
 * fetchImageResponse, safeFetch, resolveSecret) and delegates to the
 * pure warmImages orchestrator from image-warm-utils.js.
 *
 * Non-fatal per URL: warmImages catches any throw or `failed` result and
 * logs it; this function always resolves.
 *
 * @param {string[]} urls
 * @param {{ slug: string }} opts
 * @returns {Promise<void>}
 */
export function warmImagesLive(urls, { slug }) {
  const ingestFn = (url, { slug: s, channel }) =>
    ingestImage(url, {
      slug: s,
      channel,
      deps: { fetchImageResponse, safeFetch, resolveSecret, store: imageStore },
    })
  return warmImages(urls, { slug, ingestFn })
}

/**
 * Express handler for GET /content/image-source?u=<url>.
 *
 * 200 — streams image bytes with Content-Type from image-store.
 * 400 — missing `u` query parameter.
 * 404 — image not in store and ingest self-heal also failed.
 */
export async function imageSourceHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })

  // Fast path: image already in store.
  let got = await imageStore.getStream(u)

  if (!got) {
    // Slow path: self-heal by fetching and storing the original.
    // Single-flight: coalesce concurrent misses for the same URL.
    let p = _inflight.get(u)
    if (!p) {
      const channel = channelFor(u)
      p = ingestImage(u, {
        slug: '',
        channel,
        deps: { fetchImageResponse, safeFetch, resolveSecret, store: imageStore },
      }).finally(() => _inflight.delete(u))
      _inflight.set(u, p)
    }

    let result = { action: 'failed' }
    try {
      result = await p
    } catch (err) {
      // ingestImage propagates throws from fetchImageResponse (e.g. SSRF_BLOCKED,
      // network errors). Treat any throw as a fetch failure → 404.
      LOG.warn('[image-source] self-heal ingest threw:', err.message)
    }

    if (result.action === 'failed') {
      return res.status(404).json({ error: 'Image unavailable' })
    }

    got = await imageStore.getStream(u)
    if (!got) return res.status(404).json({ error: 'Image unavailable' })
  }

  res.setHeader('Content-Type', got.mimeType || 'application/octet-stream')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('X-Content-Source', 'image-store')

  got.stream.on('error', (err) => {
    LOG.warn('[image-source] stream error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' })
  })
  got.stream.pipe(res)
}
