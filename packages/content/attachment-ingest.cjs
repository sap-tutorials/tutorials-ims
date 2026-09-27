'use strict'
const crypto = require('node:crypto')
const { extToMime } = require('./attachment-mime.cjs')
const ATTACHMENT_HOSTS = new Set(['raw.githubusercontent.com'])
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024

async function ingestAttachment(sourceUrl, { slug, channel, deps }) {
  const { fetchImageResponse, safeFetch, resolveSecret, store,
          hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex') } = deps
  let host
  try { host = new URL(sourceUrl).hostname } catch { return { action: 'failed', status: 400 } }

  const res = await fetchImageResponse(sourceUrl, {
    safeFetch, resolveSecret, host, allowedHosts: ATTACHMENT_HOSTS, timeoutMs: 12000, maxRetries: 2,
  })
  if (!res.ok) return { action: 'failed', status: res.status }

  const contentLength = Number(res.headers.get('content-length'))
  if (!Number.isNaN(contentLength) && contentLength > MAX_BYTES) return { action: 'failed', status: 413 }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_BYTES) return { action: 'failed', status: 413 }

  const contentHash = hash(buffer)
  const existing = await store.head(sourceUrl)
  if (existing.exists && existing.contentHash === contentHash) return { action: 'unchanged', contentHash }

  // GitHub serves most text attachments as text/plain; trust a specific content-type,
  // otherwise derive from the extension so .json/.csv/.pdf get correct types.
  const ct = res.headers.get('content-type') || ''
  const mimeType = (ct && ct !== 'application/octet-stream') ? ct : extToMime(sourceUrl)
  const filename = sourceUrl.split('/').pop()
  await store.put(sourceUrl, { buffer, mimeType, contentHash, slug, channel, filename })
  return { action: 'stored', contentHash, mimeType }
}

module.exports = { ingestAttachment }
