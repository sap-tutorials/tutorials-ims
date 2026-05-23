/**
 * Active write-safety guard for the hybrid-qa Vitest project.
 *
 * Loaded as a vitest `setupFiles` entry — installs interceptors on:
 *
 *   1. CDS QL builders (INSERT.into / UPDATE / DELETE.from) — shadowed at
 *      `cds.ql` so any mutation throws unless ALLOW_HYBRID_WRITES=true AND
 *      (for entities with a `slug` key) the slug is prefixed with `__TEST__`.
 *
 *   2. Raw SQL on the bound DB service — wraps `srv.run(sql, ...)` after
 *      `cds.on('connect')` so any string starting (after trimming +
 *      uppercasing) with INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP is
 *      rejected unless ALLOW_HYBRID_WRITES=true. SELECT must pass through
 *      untouched — production code uses raw db.run() for HANA BLOB reads
 *      (LOB locator expiry, see CLAUDE.md).
 *
 * Rejection messages embed a stack trace fragment so failures point at
 * the offending line.
 *
 * Helpers (`isMutationSql`, `assertSlugIsTest`, `assertWritesAllowed`) are
 * exported so they can be unit-tested without booting CDS.
 */

import cds from '@sap/cds';

const TEST_PREFIX = '__TEST__';
const MUTATION_RE = /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP)\b/;
// Entities that have a `slug` key — mutations must target a __TEST__ slug.
// ContentManifest is keyed on `version`, so the slug check is skipped there;
// ALLOW_HYBRID_WRITES=true is still required.
const SLUG_KEYED_ENTITIES = new Set([
  'ContentFiles',
  'TutorialBodyText',
  'RepoCatalog',
  'Tutorials'
]);

function shortStack() {
  // Skip first 2 frames (Error + this fn) to point at the caller.
  const raw = new Error().stack || '';
  return raw.split('\n').slice(2, 6).join('\n');
}

export function isMutationSql(sql) {
  if (typeof sql !== 'string') return false;
  return MUTATION_RE.test(sql.trim().toUpperCase());
}

export function assertWritesAllowed(opLabel) {
  if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
    throw new Error(
      `[hybrid-qa guard] ${opLabel} blocked — set ALLOW_HYBRID_WRITES=true to enable writes.\n` +
      shortStack()
    );
  }
}

/**
 * Extract the unqualified entity name from whatever shape CDS QL builders
 * accept (string FQN, entity object, etc.).
 */
function entityName(target) {
  if (!target) return '';
  if (typeof target === 'string') {
    const dot = target.lastIndexOf('.');
    return dot >= 0 ? target.slice(dot + 1) : target;
  }
  // CDS entity objects have a .name (FQN) we can split.
  const fqn = target.name || target['@cds.persistence.name'] || '';
  if (typeof fqn === 'string' && fqn.length) {
    const dot = fqn.lastIndexOf('.');
    return dot >= 0 ? fqn.slice(dot + 1) : fqn;
  }
  return '';
}

/**
 * Throws if `target` is a slug-keyed entity and the supplied entries do
 * not all use a `__TEST__` slug. No-op for entities without a `slug` key.
 */
export function assertSlugIsTest(target, entries) {
  const name = entityName(target);
  if (!SLUG_KEYED_ENTITIES.has(name)) return;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const slug = row.slug;
    if (typeof slug !== 'string' || !slug.startsWith(TEST_PREFIX)) {
      throw new Error(
        `[hybrid-qa guard] write to ${name} rejected — slug must start with "${TEST_PREFIX}", got: ${JSON.stringify(slug)}\n` +
        shortStack()
      );
    }
  }
}

/**
 * Wrap CDS QL builders so every INSERT.into / UPDATE / DELETE.from passes
 * through the guard before being handed to CDS.
 */
function installQlGuards() {
  if (!cds.ql) return false;

  const origInsertInto = cds.ql.INSERT?.into?.bind(cds.ql.INSERT);
  if (origInsertInto) {
    cds.ql.INSERT.into = function guardedInsertInto(target, ...rest) {
      assertWritesAllowed(`INSERT.into(${entityName(target) || '?'})`);
      const builder = origInsertInto(target, ...rest);
      const origEntries = builder.entries?.bind(builder);
      if (origEntries) {
        builder.entries = function guardedEntries(rows) {
          assertSlugIsTest(target, rows);
          return origEntries(rows);
        };
      }
      // Also guard `.values()` / `.columns().values()` paths by re-checking
      // when the statement is finally dispatched (best-effort — rows may not
      // be available pre-execution, so the env-var check above already
      // protects us).
      return builder;
    };
  }

  const origUpdate = cds.ql.UPDATE;
  if (typeof origUpdate === 'function') {
    cds.ql.UPDATE = function guardedUpdate(target, ...rest) {
      assertWritesAllowed(`UPDATE(${entityName(target) || '?'})`);
      return origUpdate.call(cds.ql, target, ...rest);
    };
    // Preserve any static helpers attached to UPDATE (e.g. UPDATE.entity).
    Object.assign(cds.ql.UPDATE, origUpdate);
  }

  const origDeleteFrom = cds.ql.DELETE?.from?.bind(cds.ql.DELETE);
  if (origDeleteFrom) {
    cds.ql.DELETE.from = function guardedDeleteFrom(target, ...rest) {
      assertWritesAllowed(`DELETE.from(${entityName(target) || '?'})`);
      return origDeleteFrom(target, ...rest);
    };
  }

  return true;
}

/**
 * Wrap srv.run so raw mutating SQL is rejected unless writes are allowed.
 * Reads (SELECT) pass through untouched.
 */
export function wrapServiceRun(srv) {
  if (!srv || typeof srv.run !== 'function' || srv.__hybridQaGuarded) return srv;
  const origRun = srv.run.bind(srv);
  // Async wrapper so rejection-style assertions (expect(...).rejects.toThrow)
  // see a promise rejection rather than a synchronous throw.
  srv.run = async function guardedRun(sqlOrCqn, ...rest) {
    if (typeof sqlOrCqn === 'string' && isMutationSql(sqlOrCqn)) {
      assertWritesAllowed(`db.run("${sqlOrCqn.trim().slice(0, 60)}…")`);
    }
    return origRun(sqlOrCqn, ...rest);
  };
  Object.defineProperty(srv, '__hybridQaGuarded', { value: true });
  return srv;
}

// --- side-effect installation (setupFiles entry) ---

installQlGuards();

// `cds.db` only exists post-connect; subscribe to all connect events and
// wrap the bound service when it shows up.
cds.on('connect', (srv) => {
  if (srv && (srv.name === 'db' || srv === cds.db)) {
    wrapServiceRun(srv);
  }
});
