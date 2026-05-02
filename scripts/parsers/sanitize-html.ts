/**
 * Strips dangerous HTML tags and attributes from tutorial content
 * while preserving safe structural/formatting tags.
 *
 * Used in the Hugo build path where `unsafe = true` renders raw HTML.
 * This is a denylist approach: we remove known-dangerous elements
 * rather than escaping all HTML (which would break legitimate tutorial markup).
 */

const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'applet',
  'form', 'input', 'textarea', 'button', 'select',
  'link', 'meta', 'base', 'svg', 'math',
  'foreignObject', 'animate', 'animateTransform', 'set',
])

const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const JAVASCRIPT_HREF_RE = /\s+(href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi

export function stripDangerousHtml(content: string): string {
  const lines = content.split('\n')
  let inCodeFence = false
  let fenceChar = ''
  let fenceLen = 0

  const result = lines.map(line => {
    if (inCodeFence) {
      const closeMatch = line.match(/^(\s*)(```+|~~~+)\s*$/)
      if (closeMatch && closeMatch[2].charAt(0) === fenceChar && closeMatch[2].length >= fenceLen) {
        inCodeFence = false
      }
      return line
    }

    const openMatch = line.match(/^(\s*)(```+|~~~+)(.*)$/)
    if (openMatch) {
      inCodeFence = true
      fenceChar = openMatch[2].charAt(0)
      fenceLen = openMatch[2].length
      return line
    }

    return sanitizeLine(line)
  })

  return result.join('\n')
}

function sanitizeLine(line: string): string {
  let result = line
    .replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9:._-]*)[^>]*\/?>/g, (match, _slash: string, tagName: string) => {
      if (DANGEROUS_TAGS.has(tagName.toLowerCase())) return ''
      return match
    })

  result = result.replace(EVENT_ATTR_RE, '')
  result = result.replace(JAVASCRIPT_HREF_RE, '')

  return result
}
