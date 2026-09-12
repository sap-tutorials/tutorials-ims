import { SignJWT } from 'jose';
import { getSigningKey } from './provenance-keys.js';
import { deriveConfidence } from './provenance-freshness.js';

const ISS = 'https://developers.sap.com';
const SOURCE_REPO = 'sap-tutorials/Tutorials';
const TTL_SECONDS = 86400;
const _cache = new Map(); // key -> { jws, claims }

function cacheKey({ slug, contentHash, report }) {
  return `${slug}:${contentHash}:${report?.runAt || 'none'}`;
}

export async function buildEnvelope({ slug, contentHash, sourceCommit, builtAt, report, now = Date.now() }) {
  const signer = await getSigningKey();
  if (!signer) return null; // fail-open: no key configured

  const key = cacheKey({ slug, contentHash, report });
  const hit = _cache.get(key);
  if (hit && hit.claims.exp * 1000 > now) return hit;

  const iat = Math.floor(now / 1000);
  const claims = {
    iss: ISS, sub: slug, iat, exp: iat + TTL_SECONDS,
    contentHash,
    provenance: { sourceRepo: SOURCE_REPO, sourceCommit: sourceCommit ?? null, builtAt: builtAt ?? null },
    freshness: {
      confidence: deriveConfidence({ report, now }),
      lastScanned: report?.runAt ?? null,
      openHighCount: report?.openHighCount ?? 0,
      detectorModel: report?.model ?? null,
    },
  };

  try {
    const { iss, sub, iat: _i, exp, ...rest } = claims;
    const jws = await new SignJWT(rest)
      .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid, typ: 'application/tutorial-provenance+jws' })
      .setIssuer(ISS).setSubject(slug).setIssuedAt(iat).setExpirationTime(claims.exp)
      .sign(signer.key);
    const envelope = { jws, claims };
    _cache.set(key, envelope);
    return envelope;
  } catch (e) {
    console.warn('[provenance-envelope] signing failed, fail-open:', e.message);
    return null;
  }
}

export function __clearEnvelopeCacheForTest() { _cache.clear(); }
