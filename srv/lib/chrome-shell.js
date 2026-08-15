// srv/lib/chrome-shell.js
//
// Owns the __shell__ ContentFiles BLOB lifecycle for catalog pages:
// - Load lazily on first use
// - Cache parsed { before, after } halves keyed by ContentManifest.version
// - Compose full HTML by splicing a body string + page-meta into the chrome
//
// The shell itself is produced by Hugo's `_shell` layout (a one-page layout
// emitting baseof.html chrome around a single <!-- MAIN --> marker), then
// shipped as ContentFiles slug "__shell__" via scripts/publish-content.ts.
//
// Failure handling: if the shell is missing or malformed, the caller in
// content-store.js falls back to a minimal stripped shell so a broken publish
// never 500s catalog requests.

import cds from '@sap/cds';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const SHELL_SLUG = '__shell__';
const MARKER = '<!-- MAIN -->';

export class ShellMarkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellMarkerError';
  }
}

// Pure: split a shell HTML string on <!-- MAIN -->. Throws on missing or
// duplicated marker so a malformed publish surfaces immediately.
export function parseShell(html) {
  const idx = html.indexOf(MARKER);
  if (idx === -1) {
    throw new ShellMarkerError(`shell missing ${MARKER}`);
  }
  const second = html.indexOf(MARKER, idx + MARKER.length);
  if (second !== -1) {
    throw new ShellMarkerError(`shell has duplicate ${MARKER}`);
  }
  return {
    before: html.slice(0, idx),
    after: html.slice(idx + MARKER.length),
  };
}

const escapeAttr = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Public origin every composed page canonicalises to. The _shell BLOB bakes
// canonical/og:url pointing at /_shell/ (the utility Hugo page the chrome is
// sliced from), so composeShell must rewrite them per page. Matches the
// baseURL Hugo uses for real pages' canonical hrefs and the head-jsonld base.
const CANONICAL_ORIGIN = 'https://developers.sap.com';

// Every composeShell-rendered page (concept, concepts-index, group, mission)
// is public, indexable content — but the _shell page is `robotsNoIndex: true`,
// so its baked `<meta name=robots content="noindex, nofollow">` leaks onto all
// of them (verified live 2026-08-14, #1795). Force the indexable directive,
// byte-identical to hugo/layouts/partials/head-meta.html so composed pages
// match Hugo-baked ones.
const INDEXABLE_ROBOTS =
  'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

// Derive the public canonical URL for a composed page from its page-meta.
// `meta.canonicalUrl` overrides; otherwise keyed on `meta.kind` (the four
// composeShell call sites). Unknown kinds return null so the shell's baked
// value is left untouched rather than replaced with a wrong URL.
// group/mission slugs are already prefixed (`group-…`/`mission-…`) and served
// under /tutorials/; concept slugs are bare and served under /concepts/.
export function canonicalUrlFor(meta) {
  if (meta.canonicalUrl) return meta.canonicalUrl;
  const slug = String(meta.slug ?? '');
  switch (meta.kind) {
    case 'concept':        return `${CANONICAL_ORIGIN}/concepts/${slug}/`;
    case 'concepts-index': return `${CANONICAL_ORIGIN}/concepts/`;
    case 'group':
    case 'mission':        return `${CANONICAL_ORIGIN}/tutorials/${slug}/`;
    default:               return null;
  }
}

// Pure: compose full HTML from parsed shell halves + body + page meta.
// Rewrites the _shell placeholders the sliced chrome carries so each composed
// page emits its own SEO head: <html data-page-*>, <title>, <meta description>,
// <meta robots>, <link canonical>, and the og:/twitter: title/description/url
// tags. Everything else in the chrome is preserved verbatim.
//
// The published _shell BLOB is produced by Hugo's production minifier, which
// strips quotes around single-token attribute values (data-page-kind="generic"
// becomes data-page-kind=generic) and empty values (data-page-slug="" becomes
// data-page-slug). The substitution patterns below therefore tolerate quoted,
// single-quoted, and unquoted/empty forms — matching on quoted-only silently
// no-ops on the minified shell, leaving group/mission pages stamped with the
// placeholder kind 'generic' and title '_shell' (#1291). A non-matching
// .replace() is a harmless no-op, so shells lacking a given tag (e.g. the
// minimal test shell) pass through unchanged.
export function composeShell({ before, after }, bodyHtml, meta) {
  const kind  = escapeAttr(meta.kind);
  const slug  = escapeAttr(meta.slug);
  const title = escapeAttr(meta.title);
  const desc  = escapeAttr(meta.description ?? '');
  const url   = canonicalUrlFor(meta);
  const urlAttr = url ? escapeAttr(url) : null;

  // Matches `name="v"`, `name='v'`, `name=v`, or bare `name` (empty minified
  // value). The value alternation is ordered longest-first so the unquoted
  // branch doesn't shadow the quoted ones.
  const attr = (name) =>
    new RegExp(`${name}(?:="[^"]*"|='[^']*'|=[^\\s>]*)?`);

  // A `<meta {attr}={target} content="…">` tag whose {attr} value may be
  // quoted, single-quoted, or unquoted (minified). `content` is always quoted
  // in the shell (its values carry spaces/punctuation the minifier can't strip).
  const metaTag = (attrName, target) =>
    new RegExp(`<meta ${attrName}=(?:"${target}"|'${target}'|${target}) content="[^"]*">`);

  let patchedBefore = before
    .replace(attr('data-page-kind'), `data-page-kind="${kind}"`)
    .replace(attr('data-page-slug'), `data-page-slug="${slug}"`)
    .replace(attr('data-page-title'), `data-page-title="${title}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      metaTag('name', 'description'),
      `<meta name="description" content="${desc}">`,
    )
    // Utility-page noindex → indexable (#1795).
    .replace(
      metaTag('name', 'robots'),
      `<meta name="robots" content="${INDEXABLE_ROBOTS}">`,
    )
    // Social-card title/description leak `_shell` / the site-default text.
    .replace(metaTag('property', 'og:title'), `<meta property="og:title" content="${title}">`)
    .replace(metaTag('name', 'twitter:title'), `<meta name="twitter:title" content="${title}">`);

  // og:/twitter: description only when we have a real one — otherwise leave the
  // baked site-default description (better than an empty social card).
  if (desc) {
    patchedBefore = patchedBefore
      .replace(metaTag('property', 'og:description'), `<meta property="og:description" content="${desc}">`)
      .replace(metaTag('name', 'twitter:description'), `<meta name="twitter:description" content="${desc}">`);
  }

  // canonical + og:url — only when we can derive the real URL, so an unknown
  // page kind never gets stamped with a wrong canonical.
  if (urlAttr) {
    patchedBefore = patchedBefore
      .replace(
        /<link rel=(?:"canonical"|'canonical'|canonical) href=(?:"[^"]*"|'[^']*'|[^\s>]*)\s*\/?>/,
        `<link rel="canonical" href="${urlAttr}">`,
      )
      .replace(metaTag('property', 'og:url'), `<meta property="og:url" content="${urlAttr}">`);
  }

  return `${patchedBefore}${bodyHtml}${after}`;
}

// Stateful loader. Reads the active shell from ContentFiles once per
// manifest version and caches the parsed halves. Exported as a factory so
// content-store.js can pass in its already-bound namespace + getActiveVersion.
export function createShellLoader({ namespace, hanaTableName, getActiveVersion }) {
  let cached = null;  // { version, parsed }

  async function loadShellBlob(version) {
    const { ContentFiles } = cds.entities(namespace);
    const db = await cds.connect.to('db');

    let buf;
    if (db.options?.kind === 'hana' || db.constructor?.name === 'HANAService') {
      const [row] = await db.run(
        `SELECT TOP 1 "CONTENT" FROM "${hanaTableName()}" WHERE "SLUG" = ? AND "VERSION" = ?`,
        [SHELL_SLUG, version],
      );
      buf = row?.CONTENT;
    } else {
      const row = await SELECT.one.from(ContentFiles)
        .where({ slug: SHELL_SLUG, version })
        .columns('content');
      if (!row) return null;
      buf = row.content;
      if (buf instanceof Readable) {
        const chunks = [];
        for await (const c of buf) chunks.push(c);
        buf = Buffer.concat(chunks);
      } else if (buf && typeof buf.read === 'function') {
        // Some adapters return a hybrid stream — fall back to read().
        buf = await new Promise((resolve, reject) => {
          const chunks = [];
          buf.on('data', c => chunks.push(c));
          buf.on('end', () => resolve(Buffer.concat(chunks)));
          buf.on('error', reject);
        });
      }
    }
    if (!buf) return null;
    return gunzipSync(buf).toString('utf-8');
  }

  return {
    // Returns { before, after, version } or null if unavailable.
    async get() {
      const version = await getActiveVersion();
      if (version === null) return null;
      if (cached && cached.version === version) return { ...cached.parsed, version };
      const html = await loadShellBlob(version);
      if (!html) return null;
      const parsed = parseShell(html);
      cached = { version, parsed };
      return { ...parsed, version };
    },
    invalidate() { cached = null; },
  };
}
