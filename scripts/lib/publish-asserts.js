import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.assert.json';

/**
 * Reads every .assert.json sidecar in cacheDir and returns a flat array of
 * { slug, index, stepNumber, type, ...typeSpecificFields }.
 *
 * Defensive: missing dir, malformed JSON, or missing required fields are all
 * silently skipped — a parse failure must never abort the content publish.
 */
export function collectAssertSpecs(cacheDir) {
  const out = [];
  let entries;
  try { entries = readdirSync(cacheDir); } catch { return out; }
  for (const file of entries) {
    if (!file.endsWith(SUFFIX)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(cacheDir, file), 'utf8'));
    } catch { continue; }
    if (!parsed || !parsed.slug || !Array.isArray(parsed.specs)) continue;
    for (const spec of parsed.specs) {
      out.push({ slug: parsed.slug, ...spec });
    }
  }
  return out;
}

/**
 * POST the consolidated specs to /content/assert-specs.
 * Returns the server's response shape: { upserted, skipped }.
 */
export async function publishAssertSpecs(baseUrl, apiKey, specs) {
  if (!specs.length) return { upserted: 0, skipped: [] };
  const res = await fetch(`${baseUrl}/content/assert-specs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ specs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`assert-spec publish failed (${res.status}): ${txt}`);
  }
  return await res.json();
}
