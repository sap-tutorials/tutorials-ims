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

// Pure: compose full HTML from parsed shell halves + body + page meta.
// Substitutes <html data-page-* attributes, <title>, and <meta description>
// for the placeholders the _shell layout emits.
export function composeShell({ before, after }, bodyHtml, meta) {
  const kind  = escapeAttr(meta.kind);
  const slug  = escapeAttr(meta.slug);
  const title = escapeAttr(meta.title);
  const desc  = escapeAttr(meta.description ?? '');

  const patchedBefore = before
    .replace(/data-page-kind="[^"]*"/, `data-page-kind="${kind}"`)
    .replace(/data-page-slug="[^"]*"/, `data-page-slug="${slug}"`)
    .replace(/data-page-title="[^"]*"/, `data-page-title="${title}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${desc}">`,
    );

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
