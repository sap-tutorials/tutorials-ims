// scripts/lib/publish-challenge-answers.js
// Uploads challenge-widget freeText reference answers after the main
// /content/publish run (#2441).
//
// Walks `cacheDir` for `<slug>.challenge-answers.json` sidecars emitted by
// scripts/fetch-tutorials.ts and POSTs each one to /content/challenge-answers
// with the CONTENT_API_KEY bearer.
//
// Failures are NON-FATAL — captured in the `failures` array and returned to the
// caller. A single bad slug must not abort the publish run. Mirrors
// scripts/lib/publish-validate-answer.js (the AI-quiz path this clones): one
// POST per slug because the server's REPLACE-by-slug semantics expect a single
// { slug, answers } body.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SUFFIX = '.challenge-answers.json';

/**
 * Walk cacheDir for *.challenge-answers.json sidecar files,
 * POST each one to /content/challenge-answers.
 *
 * @param {object} opts
 * @param {string} opts.cacheDir - Tutorial cache dir (e.g. .tutorial-cache)
 * @param {string} opts.baseUrl  - CAP base URL
 * @param {string} opts.apiKey   - CONTENT_API_KEY value (param, not env)
 * @param {Function} [opts.fetch] - injected fetch (for testing)
 * @returns {Promise<{published: number, failures: Array<{slug: string, status: number, body: string}>}>}
 */
export async function publishChallengeAnswers({ cacheDir, baseUrl, apiKey, fetch: injectedFetch }) {
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
      // Malformed JSON or read failure — skip silently; must never abort publish.
      continue;
    }
    if (!parsed || typeof parsed.slug !== 'string' || !Array.isArray(parsed.answers)) continue;

    let res;
    try {
      res = await f(`${baseUrl}/content/challenge-answers`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        // Raw bytes — the sidecar was written as `{ slug, answers }` in exactly
        // the shape the endpoint expects, so we don't re-stringify.
        body: raw,
      });
    } catch (err) {
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
      failures.push({ slug: parsed.slug, status: res.status, body: bodyText });
      continue;
    }
    published++;
  }

  return { published, failures };
}
