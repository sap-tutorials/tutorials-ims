'use strict'
const crypto = require('node:crypto')
const IMG_CDN_HOSTS = new Set(['raw.githubusercontent.com'])
const MAX_IMAGE_BYTES = Number(process.env.IMG_MAX_BYTES) || 25 * 1024 * 1024  // 25 MB default

async function ingestImage(sourceUrl, { slug, channel, deps }) {
  const { fetchImageResponse, safeFetch, resolveSecret, store,
          hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex') } = deps
  let host
  try { host = new URL(sourceUrl).hostname } catch { return { action: 'failed', status: 400 } }

  const res = await fetchImageResponse(sourceUrl, {
    safeFetch, resolveSecret, host, allowedHosts: IMG_CDN_HOSTS,
    timeoutMs: 12000, maxRetries: 2,
  })
  if (!res.ok) return { action: 'failed', status: res.status }

  // Reject oversized responses before buffering (content-length fast-path)
  const contentLength = Number(res.headers.get('content-length'))
  if (!Number.isNaN(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    return { action: 'failed', status: 413 }
  }

  const buffer = Buffer.from(await res.arrayBuffer())

  // Defensive check for chunked/absent content-length
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { action: 'failed', status: 413 }
  }

  const contentHash = hash(buffer)
  const existing = await store.head(sourceUrl)
  if (existing.exists && existing.contentHash === contentHash) {
    return { action: 'unchanged', contentHash }
  }
  const mimeType = res.headers.get('content-type') || 'application/octet-stream'
  await store.put(sourceUrl, { buffer, mimeType, contentHash, slug, channel })
  return { action: 'stored', contentHash, mimeType }
}

module.exports = { ingestImage }
