import { join } from 'node:path';
import { writeAuthorPagesFromIndex } from './lib/author-pages-writer.js';
import type { AuthorIndex } from './parsers/author-index.js';

// scripts/seed-authors-from-deployed.ts
//
// Fixes the "catalog-only rebuild wipes /authors/*" bug (analogue of the
// 2026-08-07 /browse/ incident — see scripts/seed-browse-from-deployed.ts).
//
// THE BUG
//   /authors/{login}/ pages (#1732) are served from the approuter's OWN static
//   dir (xs-app.json catch-all → static), NOT proxied to HANA. Each page is
//   generated at Hugo build time from a per-login `<login>.md` stub plus
//   hugo/data/author_index.json — both written ONLY by writeAuthorPages() inside
//   scripts/fetch-tutorials.ts.
//
//   The rebuild-content workflow SKIPS fetch-tutorials.ts in `catalog-only` mode
//   ("Fetch tutorials" step is `if effective_mode != 'catalog-only'`), so no
//   author stubs / author_index.json are produced — but it STILL runs the Hugo
//   build, "Assemble static content", and "Push content to AppRouter" (gated
//   only `!= 'slug-targeted'`). The push handler ATOMICALLY replaces the whole
//   approuter STATIC_DIR with the tarball, so a catalog-only rebuild wipes every
//   /authors/{login}/ page a prior full rebuild / mta deploy had shipped.
//
// WHY NOT just regenerate authors in catalog-only?
//   buildAuthorIndex() needs per-tutorial author attribution (authorProfile,
//   top-contributor login, createdAt) that comes ONLY from the GitHub tutorial
//   markdown fetch. /build/catalog carries no author fields. catalog-only
//   deliberately skips that fetch (it's the fast admin-edit path), so the data
//   to rebuild author pages from scratch is not present. Running the fetch would
//   defeat the mode — exactly the browse constraint.
//
// THE FIX (this script)
//   In catalog-only mode, BEFORE the Hugo build, re-hydrate author_index.json
//   from the copy the approuter is CURRENTLY serving at /author_index.json
//   (published by writeAuthorPages during the last full build), then regenerate
//   the per-login stubs + data file + the served copy from it. Hugo then
//   re-renders the SAME author pages and the tarball ships them — including
//   /author_index.json again, so the NEXT catalog-only rebuild can re-hydrate
//   too (the chain is self-sustaining across consecutive content-only rebuilds).
//
// FAIL-SAFE
//   If the deployed /author_index.json can't be fetched, isn't valid JSON, or is
//   empty ({}), this script EXITS NON-ZERO without writing — deliberately FAILING
//   the catalog-only rebuild rather than shipping a wiped /authors/*. A hard
//   failure is visible and recoverable (re-run mode=full, which republishes
//   /author_index.json); silently wiping the pages is the incident this fixes.
//   The one acceptable "empty" case — a genuinely author-less site — is handled
//   by ALLOW_EMPTY_AUTHORS=1.
//
//   BOOTSTRAP: the first catalog-only run AFTER this fix deploys but BEFORE a
//   full rebuild has published /author_index.json will fail-safe here. Resolve
//   by running mode=full once (it publishes the asset); catalog-only works from
//   then on.

const APPROUTER_URL = (process.env.APPROUTER_URL || '').replace(/\/+$/, '');
// Channel-aware target, mirroring scripts/fetch-tutorials.ts. Paths are relative
// to the repo root (this script runs from there in CI, like seed-browse):
// prod → hugo/data + hugo/content/authors; qa → hugo/data-qa + hugo/content-qa.
const CHANNEL = process.env.AUTHOR_CHANNEL === 'qa' ? 'qa' : 'prod';
const DATA_FILE = join('hugo', CHANNEL === 'qa' ? 'data-qa' : 'data', 'author_index.json');
const CONTENT_DIR = join('hugo', CHANNEL === 'qa' ? 'content-qa' : 'content', 'authors');
// prod publishes the served copy; qa does not (its rebuild workflow is separate).
const PUBLISH_FILE = CHANNEL === 'qa' ? undefined : join('hugo', 'static', 'author_index.json');
const ALLOW_EMPTY = process.env.ALLOW_EMPTY_AUTHORS === '1';

/**
 * Parse a fetched /author_index.json body into an AuthorIndex. Throws (never
 * process.exit) so it stays pure + unit-testable; main() maps the throw to a
 * fail-safe non-zero exit.
 */
export function parseAuthorIndex(text: string): AuthorIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`/author_index.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('/author_index.json did not parse to an object');
  }
  return parsed as AuthorIndex;
}

function die(msg: string): never {
  console.error(`[seed-authors] FAILED: ${msg}`);
  console.error('[seed-authors] Refusing to proceed — a catalog-only rebuild must not ship a wiped /authors/*.');
  console.error('[seed-authors] Recover by re-running the rebuild with mode=full, or set ALLOW_EMPTY_AUTHORS=1 if the site genuinely has no author pages.');
  process.exit(1);
}

async function main() {
  if (!APPROUTER_URL) die('APPROUTER_URL is not set');

  let body: string;
  try {
    const res = await fetch(`${APPROUTER_URL}/author_index.json`, { redirect: 'follow' });
    if (!res.ok) die(`GET ${APPROUTER_URL}/author_index.json returned ${res.status}`);
    body = await res.text();
  } catch (err) {
    die(`could not fetch ${APPROUTER_URL}/author_index.json — ${err instanceof Error ? err.message : err}`);
  }

  let index: AuthorIndex;
  try {
    index = parseAuthorIndex(body);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const loginCount = Object.keys(index).length;
  if (loginCount === 0 && !ALLOW_EMPTY) {
    die('deployed /author_index.json is empty ({}). This env has no author pages to preserve — a previous catalog-only rebuild may have already wiped them. Re-run with mode=full to regenerate.');
  }

  const { pagesWritten } = writeAuthorPagesFromIndex({
    index,
    dataFile: DATA_FILE,
    contentDir: CONTENT_DIR,
    publishFile: PUBLISH_FILE,
  });
  console.log(
    `[seed-authors] preserved ${loginCount} author(s) → wrote ${pagesWritten} page stub(s), ${DATA_FILE} + published copy (from deployed ${APPROUTER_URL}/author_index.json)`,
  );
}

// Only run main() when invoked directly (not when imported by the unit test).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
