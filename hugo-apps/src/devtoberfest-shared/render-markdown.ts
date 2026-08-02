// Renders markdown to sanitized HTML using the globally-loaded
// window.markdownit + window.DOMPurify (see hugo/layouts/_default/baseof.html).
// Mirrors the config in hugo/static/js/joule-render.js exactly.
// Falls back to HTML-escaped plain text when the globals are unavailable
// (e.g. a load race or a unit test without them) so pages stay readable.

declare global {
  interface Window {
    markdownit?: (opts?: Record<string, unknown>) => { render: (src: string) => string }
    DOMPurify?: { sanitize: (html: string, opts?: Record<string, unknown>) => string }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const md = typeof window !== 'undefined' ? window.markdownit : undefined
  const purify = typeof window !== 'undefined' ? window.DOMPurify : undefined
  if (!md || !purify) {
    return escapeHtml(src)
  }
  const renderer = md({ html: false, linkify: true, breaks: true })
  const dirty = renderer.render(src)
  return purify.sanitize(dirty, { USE_PROFILES: { html: true } })
}
