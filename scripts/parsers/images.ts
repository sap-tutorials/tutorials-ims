import { RAW_BASE_URL } from './types.js'

export interface ImageResolveOpts {
  repo: string
  branch: string
  slug: string
  rewriteImages?: boolean
}

/**
 * Strip the authoring directive comment (`<!-- border -->`, `<!-- size:540px -->`,
 * or any combination like `<!-- border; size:540px -->`) that prefixes an image.
 *
 * If this comment survives into the body, goldmark treats the leading `<!--` as
 * the start of an HTML block and consumes the trailing `![…]` as raw HTML text,
 * so the image never renders (#1137). The directives may appear in either order,
 * separated by `;` and/or whitespace. Only comments composed solely of these
 * known directives are stripped — unrelated comments are left intact.
 *
 * Extracted from `resolveImageURLs` so the source-markdown scanner (issue #1963)
 * and this in-flight pre-processor share ONE detection/transform and can never
 * disagree. Pure, idempotent, and independent of repo/branch/URL context — the
 * only part of image handling that is a genuine *source* fix (the URL rewrite is
 * render-time and stays here, not in the scanner).
 */
export function stripImageDirectiveComments(content: string): string {
  return content.replace(
    /<!--\s*(?:border|size:\s*\d+px)(?:\s*;?\s*(?:border|size:\s*\d+px))*\s*-->\s*(!\[)/g,
    '$1'
  )
}

export function resolveImageURLs(content: string, opts: ImageResolveOpts): string {
  const { repo, branch, slug, rewriteImages = true } = opts
  let result = content

  if (rewriteImages) {
    const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`
    result = result.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt: string, path: string) => {
        if (path.startsWith('http://') || path.startsWith('https://')) return _match
        if (path.includes('../')) return _match
        const clean = path.replace(/^\.?\//, '')
        return `![${alt}](${base}/${clean})`
      }
    )
  }

  return stripImageDirectiveComments(result)
}
