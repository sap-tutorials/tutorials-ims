/**
 * Trusted-host allowlist for redirect targets (#752).
 *
 * Extends the #891 open-redirect guard: a redirect target is allowed if it is
 * a same-origin absolute path (existing behavior) OR an https:// URL whose host
 * is on the curated SAP allowlist below. Everything else (http:, javascript:,
 * data:, protocol-relative //host, arbitrary external hosts) stays rejected.
 *
 * Adding a destination is a deliberate, PR-reviewed edit to ALLOWED_HOSTS —
 * admins cannot introduce external targets through the admin UI.
 *
 * MIRROR: copied to approuter/lib/ at MTA build time (mta.yaml before-all).
 * Source of truth is this srv/lib copy. Keep both in sync.
 *
 * @module redirect-allowlist
 */
import { isSameOriginPath } from './legacy-redirects-resolver.js';

export const ALLOWED_HOSTS = new Set([
  'community.sap.com',
  'pages.community.sap.com',
  'opensource.sap.com',
  'www.sap.com',
  'help.sap.com',
]);

/**
 * @param {string} toPath
 * @returns {boolean}
 */
export function isAllowedTarget(toPath) {
  if (isSameOriginPath(toPath)) return true;
  let u;
  try {
    u = new URL(toPath);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.has(u.host);
}
