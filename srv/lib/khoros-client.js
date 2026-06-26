// srv/lib/khoros-client.js
//
// Anonymous SAP Community user lookup. Ported from
// https://github.com/SAP-samples/sap-community-activity-badges
// (srv/util/khoros.js::searchAuthor + callUserAPI), flipped from
// then-request to Node.js native fetch per CLAUDE.md.
//
// Khoros's direct /api/2.0/users/:id endpoint started returning 404 in
// mid-2026 for anonymous callers (permission revocation). We project
// messages.author.* against /api/2.0/search instead — the only public-tier
// surface that still works without a service principal. A user with
// zero community posts cannot be found via this path.
//
// Spec: docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md
// Issue: #566

// Lazy cds.log so unit tests without @sap/cds installed don't crash.
function warn(...args) {
  try {
    // eslint-disable-next-line global-require
    const cds = require('@sap/cds');
    cds.log('khoros').warn(...args);
  } catch {
    // Test environment — drop silently.
  }
}

// Khoros tenant prefix. SAP Community uses `khhcw49343` for community.sap.com;
// Khoros has historically rotated similar prefixes. Single named constant
// so a future rotation is a one-line change.
export const KHOROS_TENANT_PREFIX = 'khhcw49343';

const SEARCH_BASE = `https://community.sap.com/${KHOROS_TENANT_PREFIX}/api/2.0/search`;

const AUTHOR_FIELDS = [
  'author.id',
  'author.login',
  'author.first_name',
  'author.last_name',
  'author.rank.name',
  'author.avatar.profile',
  'author.view_href',
].join(', ');

async function searchAuthor(whereClause) {
  const query = `SELECT ${AUTHOR_FIELDS} FROM messages WHERE ${whereClause} LIMIT 1`;
  const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error(`khoros upstream ${res.status}`);
    }
    throw new Error(`khoros HTTP ${res.status}`);
  }
  const body = JSON.parse(await res.text());
  if (body.status !== 'success') {
    throw new Error(`khoros search failed: ${body.message || JSON.stringify(body)}`);
  }
  const items = body?.data?.items || [];
  if (items.length === 0) {
    // Empty-on-success is the silent symptom of a Khoros permission
    // revocation. Log so a future revocation shows up in operator logs.
    warn(`searchAuthor returned 0 items for WHERE ${whereClause}`);
    return null;
  }
  return items[0]?.author || null;
}

function shape(author) {
  if (!author) return null;
  const name = [author.first_name, author.last_name].filter(Boolean).join(' ').trim();
  return {
    id: author.id,
    login: author.login,
    name: name || author.login,
    rank: author.rank?.name || '',
    avatarUrl: author.avatar?.profile || '',
  };
}

/**
 * Resolve a Khoros user from either a numeric id or a login slug.
 *
 * @param {string} input — user-typed: "12345" or "thomas_jung" or "thomas.jung"
 * @returns {Promise<{id, login, name, rank, avatarUrl} | null>}
 *   Null = upstream returned 0 items (lurker, deleted, or unknown).
 *   Throws on 5xx, non-success status, or network error.
 */
export async function resolveUser(input) {
  const id = String(input).trim();
  if (!id) return null;
  const isNumeric = /^\d+$/.test(id);

  if (isNumeric) {
    const author = await searchAuthor(`author.id = '${id}'`);
    return author ? shape(author) : null;
  }

  // Slug path: try dot-to-underscore normalisation first (Khoros migrated
  // dotted logins like "thomas.jung" → "thomas_jung" in bulk).
  const normalised = id.replace(/\./g, '_');
  let author = await searchAuthor(`author.login = '${normalised}'`);
  if (author) return shape(author);

  // Fallback to the dotted form (handles logins Khoros didn't migrate).
  if (normalised !== id) {
    author = await searchAuthor(`author.login = '${id}'`);
    if (author) return shape(author);
  }

  return null;
}
