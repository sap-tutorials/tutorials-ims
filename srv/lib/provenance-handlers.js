import { isFlagEnabled } from './feature-flags/db-flags.js';
import { buildEnvelope } from './provenance-envelope.js';
import { loadProvenanceInputs } from './provenance-data.js';
import { getJwks } from './provenance-keys.js';

export async function provenanceHandler(req, res) {
  if (!isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')) return res.status(404).end();
  const slug = String(req.params.slug || '').toLowerCase();
  const inputs = await loadProvenanceInputs(slug);
  if (!inputs) return res.status(404).json({ error: 'not_found' });
  const envelope = await buildEnvelope({ slug, ...inputs });
  if (!envelope) return res.status(503).json({ error: 'attestation_unavailable' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600');
  res.json({ jws: envelope.jws, jwks_url: '/.well-known/tutorial-provenance/jwks.json' });
}

export async function jwksHandler(req, res) {
  if (!isFlagEnabled('PROVENANCE_ENVELOPE_ENABLED')) return res.status(404).end();
  const jwks = await getJwks();
  res.setHeader('Content-Type', 'application/jwk-set+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.json(jwks);
}
