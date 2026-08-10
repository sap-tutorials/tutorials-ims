// Mirrors the approuter CSP frame-ancestors allow-list.
export const DEFAULT_ALLOWED_ORIGIN_PATTERNS: string[] = [
  'https://*.sap.com',
  'https://*.sap.cn',
  'https://*.cloud.sap',
];

function patternToRegExp(pattern: string): RegExp {
  // Only scheme + host wildcards are supported (e.g. https://*.sap.com).
  // Escape everything, then turn an escaped "\*\." into a "match one-or-more
  // subdomain labels" group. Anchored end-to-end so suffix attacks fail.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withWildcard = escaped.replace(/\\\*\\\./g, '(?:[a-z0-9-]+\\.)+');
  return new RegExp('^' + withWildcard + '$', 'i');
}

export function isOriginAllowed(
  origin: string,
  patterns: string[] = DEFAULT_ALLOWED_ORIGIN_PATTERNS,
  selfOrigin?: string,
): boolean {
  if (!origin || origin === '*') return false;
  if (selfOrigin && origin === selfOrigin) return true;
  return patterns.some(p => patternToRegExp(p).test(origin));
}
