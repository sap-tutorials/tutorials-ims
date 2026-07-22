// srv/lib/deploy-environment.js
//
// Issue #1268 — derive a coarse deploy-environment label (DEV / PROD / QA /
// LOCAL) so the Admin Console header can show which system the operator is
// looking at. DEV and PROD share one BTP subaccount + XSUAA tenant (see memory
// `prod-shared-xsuaa-tenant-...`), so the *only* trustworthy runtime signal is
// the Cloud Foundry space name carried on `VCAP_APPLICATION.space_name`
// ('dev' / 'prod'; QA lives in the same space as its parent). We do NOT sniff
// the request Host header — it is spoofable and the header-injection guard at
// srv/server.js already prefers VCAP over headers for the same reason.

/**
 * Resolve the coarse deploy environment from the CF space name.
 *
 * @param {string} [rawVcap]  Override for VCAP_APPLICATION JSON (tests).
 * @returns {{ id: string, label: string, space: (string|null) }}
 *   id    — machine token: 'dev' | 'prod' | 'qa' | 'local' | 'other'
 *   label — short uppercase badge text: 'DEV' | 'PROD' | 'QA' | 'LOCAL' | space
 *   space — the raw CF space name, or null when not running on CF
 */
export function resolveDeployEnvironment(rawVcap = process.env.VCAP_APPLICATION) {
  let space = null;
  if (rawVcap) {
    try {
      const parsed = JSON.parse(rawVcap);
      if (typeof parsed.space_name === 'string' && parsed.space_name.length > 0) {
        space = parsed.space_name;
      }
    } catch {
      /* malformed VCAP → treat as not-on-CF */
    }
  }

  if (!space) {
    return { id: 'local', label: 'LOCAL', space: null };
  }

  const normalized = space.toLowerCase();
  if (normalized === 'prod' || normalized === 'production') {
    return { id: 'prod', label: 'PROD', space };
  }
  if (normalized === 'dev' || normalized === 'development') {
    return { id: 'dev', label: 'DEV', space };
  }
  if (normalized === 'qa' || normalized === 'test') {
    return { id: 'qa', label: normalized.toUpperCase(), space };
  }
  // Unknown space — surface the raw name so operators still see *something*
  // truthful rather than a misleading DEV/PROD guess.
  return { id: 'other', label: space.toUpperCase(), space };
}
