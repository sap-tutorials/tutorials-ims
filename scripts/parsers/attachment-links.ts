import { RAW_BASE_URL } from './types.js'
import { createFenceTracker } from './fence-tracker.js'

// Repo attachment file extensions served through the object store (lowercase, no dot).
// KEEP IN SYNC with the Hugo render-link hook's disposition and srv/lib/attachment-mime.cjs.
export const ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'csv', 'json', 'md', 'sql', 'abap', 'properties',
  'yaml', 'yml', 'xml', 'html', 'zip', 'pdf', 'war', 'jar', 'zargo', 'har',
])

export function isAttachmentPath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim())
  return m ? ATTACHMENT_EXTENSIONS.has(m[1].toLowerCase()) : false
}

export interface AttachmentResolveOpts {
  repo: string
  branch: string
  slug: string
  rewrite?: boolean
}

// Matches a markdown link `[text](dest)` NOT preceded by `!` (which would be an image).
// Destination captured up to whitespace or `)`; an optional `"title"` is preserved.
const LINK_RE = /(^|[^!])(\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

export function resolveAttachmentLinks(content: string, opts: AttachmentResolveOpts): string {
  const { repo, branch, slug, rewrite = true } = opts
  if (!rewrite) return content
  const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`
  const fence = createFenceTracker()
  return content
    .split('\n')
    .map((line) => {
      if (fence(line)) return line // inside a code fence — leave verbatim
      return line.replace(LINK_RE, (m, pre, open, dest, tail) => {
        if (/^(https?:\/\/|#|mailto:|\/)/i.test(dest)) return m
        if (dest.includes('../')) return m
        if (!isAttachmentPath(dest)) return m
        const clean = dest.replace(/^\.?\//, '')
        return `${pre}${open}${base}/${clean}${tail}`
      })
    })
    .join('\n')
}
