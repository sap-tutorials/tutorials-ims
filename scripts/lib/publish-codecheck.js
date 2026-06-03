import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.codecheck.json';

/**
 * Reads every .codecheck.json sidecar in cacheDir and returns a flat
 * array of { slug, stepNumber, goal, language?, hints?, referenceSolution? }.
 *
 * Defensive: missing dir, malformed JSON, or missing required fields are all
 * silently skipped — a parse failure must never abort the content publish.
 */
export function collectCodeCheckSpecs(cacheDir) {
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
 * POST the consolidated specs to /content/code-check-specs.
 * Returns the server's response shape: { upserted, skipped }.
 */
export async function publishCodeCheckSpecs(baseUrl, apiKey, specs) {
  if (!specs.length) return { upserted: 0, skipped: [] };
  const res = await fetch(`${baseUrl}/content/code-check-specs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ specs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`code-check publish failed (${res.status}): ${txt}`);
  }
  return await res.json();
}
