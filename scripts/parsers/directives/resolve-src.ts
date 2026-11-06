// scripts/parsers/directives/resolve-src.ts
//
// Shared source URL resolver for tutorial directive families (figure, compare,
// cast, diagram, etc.).
//
// Absolute URLs (starting with a scheme like https://) are returned unchanged.
// Relative paths are resolved to a raw GitHub URL under the tutorial's directory.

import { RAW_BASE_URL } from '../types.js';

/**
 * Resolve a `src` value to a full URL.
 *
 * - Absolute URLs (contain `://`) are returned as-is.
 * - Relative paths (with or without a leading `./`) are resolved to:
 *   `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}/${clean}`
 *
 * @param src    - The raw src value from the directive attribute.
 * @param repo   - The source repository name (e.g. `my-tutorials`).
 * @param branch - The source branch (e.g. `main`).
 * @param slug   - The tutorial slug (e.g. `my-tutorial`).
 */
export function resolveSrc(src: string, repo: string, branch: string, slug: string): string {
  if (src.includes('://')) {
    return src;
  }
  // Strip leading ./ if present
  const clean = src.startsWith('./') ? src.slice(2) : src;
  return `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}/${clean}`;
}
