'use strict'
// Extension→MIME + Content-Disposition policy for tutorial attachments (#1931).
// KEEP the extension set in sync with scripts/parsers/attachment-links.ts and the render-link hook.

const EXT_MIME = {
  txt: 'text/plain; charset=utf-8', csv: 'text/csv', json: 'application/json',
  md: 'text/markdown; charset=utf-8', sql: 'text/plain; charset=utf-8',
  abap: 'text/plain; charset=utf-8', properties: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8', html: 'text/html',
  zip: 'application/zip', pdf: 'application/pdf',
  war: 'application/java-archive', jar: 'application/java-archive',
  zargo: 'application/octet-stream', har: 'application/json',
}

function extToMime(filenameOrUrl) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(filenameOrUrl))
  const ext = m ? m[1].toLowerCase() : ''
  return EXT_MIME[ext] || 'application/octet-stream'
}

// Inline-viewable MIME classes (rest download).
const INLINE = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json', 'application/xml'])

function baseType(mime) { return String(mime).split(';')[0].trim().toLowerCase() }

function dispositionFor(mimeType, { download = false, filename = 'file' } = {}) {
  const safeName = String(filename).replace(/["\r\n]/g, '')
  // text/html is neutered UNCONDITIONALLY: serve as text/plain, never executed.
  const contentType = baseType(mimeType) === 'text/html' ? 'text/plain; charset=utf-8' : mimeType
  if (download) return { contentType, disposition: `attachment; filename="${safeName}"` }
  const inline = INLINE.has(baseType(contentType))
  return { contentType, disposition: `${inline ? 'inline' : 'attachment'}; filename="${safeName}"` }
}

module.exports = { extToMime, dispositionFor }
