// scripts/lib/publish-validate-answer.js
// Helper for Task 9 of issue #209 — uploads validate-answer specs after the
// main /content/publish run.
//
// Walks `cacheDir` for `<slug>.validate-answer.json` sidecars emitted by
// scripts/fetch-tutorials.ts (Task 3 of #209) and POSTs each one to
// /content/validate-answer-specs with the CONTENT_API_KEY bearer.
//
// Failures are NON-FATAL — captured in the `failures` array and returned to
// the caller. A single bad slug must not abort the publish run. Mirrors the
// shape of scripts/lib/publish-codecheck.js but POSTs once per slug because
// the server's REPLACE-by-slug semantics expect a single { slug, specs } body.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.validate-answer.json';

/**
 * Walk cacheDir for *.validate-answer.json sidecar files,
 * POST each one to /content/validate-answer-specs.
 *
 * @param {object} opts
 * @param {string} opts.cacheDir - Tutorial cache dir (e.g. .tutorial-cache)
 * @param {string} opts.baseUrl  - CAP base URL
 * @param {string} opts.apiKey   - CONTENT_API_KEY value (param, not env — see test 6)
 * @param {Function} [opts.fetch] - injected fetch (for testing)
 * @returns {Promise<{published: number, failures: Array<{slug: string, status: number, body: string}>}>}
 */
export async function publishValidateAnswerSpecs({ cacheDir, baseUrl, apiKey, fetch: injectedFetch }) {
  const f = injectedFetch ?? globalThis.fetch;
  const failures = [];
  let published = 0;

  let entries;
  try { entries = readdirSync(cacheDir); } catch { return { published, failures }; }

  for (const file of entries) {
    if (!file.endsWith(SUFFIX)) continue;

    const filePath = path.join(cacheDir, file);
    let raw;
    let parsed;
    try {
      raw = readFileSync(filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON or read failure — skip silently. Mirrors the
      // defensive posture of collectCodeCheckSpecs: a parse failure must
      // never abort the content publish.
      continue;
    }
    if (!parsed || typeof parsed.slug !== 'string' || !Array.isArray(parsed.specs)) continue;

    let res;
    try {
      res = await f(`${baseUrl}/content/validate-answer-specs`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        // Use the raw bytes — Task 3 wrote `{ slug, specs }` exactly in the
        // shape the endpoint expects, so we don't re-stringify.
        body: raw,
      });
    } catch (err) {
      // Network error: capture and continue with the next slug.
      failures.push({
        slug: parsed.slug,
        status: 0,
        body: err && err.message ? String(err.message) : 'network_error',
      });
      continue;
    }

    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch { /* ignore */ }
      failures.push({
        slug: parsed.slug,
        status: res.status,
        body: bodyText,
      });
      continue;
    }
    published++;
  }

  return { published, failures };
}
