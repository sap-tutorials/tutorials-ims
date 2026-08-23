// srv/lib/attachment-warm-utils.js
//
// Pure attachment-warm orchestration utilities — no CDS or network deps.
// Importable from unit tests without a running CAP server.
// Analog of image-warm-utils.js
//
// Used by:
//   srv/lib/attachment-source-handler.js — imports channelFor; assembles real ingestFn
//   srv/lib/content-publish-session.js — fires warmAttachmentsLive after each append batch

export { channelFor } from './image-warm-utils.js'
import { channelFor } from './image-warm-utils.js'

/**
 * Extract and decode all unique raw-source URLs from an HTML string
 * containing `/content/attachment-source?u=<encoded>&…` references.
 *
 * The regex matches `/content/attachment-source` followed by a query string
 * containing `u=<value>`. Both `?u=` (first param) and `&u=` (later param)
 * are matched. The captured value is URL-decoded and deduplicated.
 *
 * @param {string} html — rendered tutorial HTML
 * @returns {string[]} deduplicated decoded source URLs
 */
export function extractAttachmentUrls(html) {
  const results = new Set()
  // Match /content/attachment-source (with optional path prefix) followed by a query string
  // that contains u=<encoded-url>. Captures the encoded value up to the
  // next & separator, quote, whitespace, or > character.
  const re = /\/content\/attachment-source[^"'\s>]*[?&]u=([^&"'\s>]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    try { results.add(decodeURIComponent(m[1])) } catch { /* skip malformed */ }
  }
  return [...results]
}

/**
 * Warm the attachment store for a set of source URLs.
 *
 * Non-fatal: a per-URL try/catch ensures that a failing ingest (network
 * error, 429, etc.) never propagates to the caller. Failures are logged
 * via console.warn; the publish path is never interrupted.
 *
 * @param {string[]} urls — raw source URLs to warm
 * @param {{ slug: string, ingestFn: (url: string, opts: {slug: string, channel: string}) => Promise<{action: string, status?: number}> }} opts
 *   ingestFn is injected by the caller — production code passes the real
 *   ingestAttachment wrapper; unit tests pass a vi.fn() mock.
 * @returns {Promise<void>} — always resolves; never throws
 */
export async function warmAttachments(urls, { slug, ingestFn }) {
  for (const url of urls) {
    const channel = channelFor(url)
    try {
      const result = await ingestFn(url, { slug, channel })
      if (result?.action === 'failed') {
        console.warn(`[attachment-warm] slug=${slug} u=${url}: ingest returned failed (status=${result.status})`)
      }
    } catch (err) {
      console.warn(`[attachment-warm] slug=${slug} u=${url}: ingest threw: ${err?.message}`)
    }
  }
}
