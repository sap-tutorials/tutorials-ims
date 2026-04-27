import { RAW_BASE_URL } from './types.js'

export interface ImageResolveOpts {
  repo: string
  branch: string
  slug: string
}

export function resolveImageURLs(content: string, opts: ImageResolveOpts): string {
  const { repo, branch, slug } = opts
  const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`

  let result = content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, path: string) => {
      if (path.startsWith('http://') || path.startsWith('https://')) return _match
      if (path.includes('../')) return _match
      const clean = path.replace(/^\//, '')
      return `![${alt}](${base}/${clean})`
    }
  )

  result = result.replace(/<!--\s*(?:border|size:\s*\d+px)\s*-->\s*(!\[)/g, '$1')

  return result
}
