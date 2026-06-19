import cds from '@sap/cds';

const MIGRATION_HEADER = 'x-migration-mode';
const SKIP_VAR = 'ct.skip';
const log = cds.log('migration-mode');

/**
 * Returns true iff the current cds.context represents an HTTP request
 * that carried `x-migration-mode: true` AND was authenticated as Admin.
 *
 * Reading from cds.context (AsyncLocalStorage) keeps the handler
 * inbound-protocol-agnostic: non-HTTP calls (jobs, internal CAP→CAP)
 * have no `cds.context.http`, so the gate fails closed.
 */
function migrationModeRequested() {
  const headers = cds.context?.http?.req?.headers;
  if (!headers) return false;

  const raw = headers[MIGRATION_HEADER];
  if (!raw || String(raw).toLowerCase() !== 'true') return false;

  const user = cds.context?.user;
  if (typeof user?.is !== 'function' || !user.is('Admin')) {
    log.debug?.('x-migration-mode header ignored: user not Admin');
    return false;
  }
  return true;
}

/**
 * Registers DB-level before/after handlers that set `ct.skip='true'`
 * for the duration of an admin migration request. Idempotent guard
 * against double-registration during cds.test() reloads is the
 * caller's responsibility (see srv/server.js).
 *
 * The optional `db` argument exists for unit testability; production
 * callers pass nothing and the default resolves to `cds.db`.
 */
export function registerMigrationModeHandler(db = cds.db) {
  if (!db) {
    log.warn?.('cds.db unavailable; migration-mode handler not registered');
    return;
  }

  db.before(['INSERT', 'UPDATE', 'DELETE'], async (req) => {
    if (!migrationModeRequested()) return;
    if (typeof req._tx?.set !== 'function') {
      log.warn?.('migration mode requested but req._tx.set unavailable');
      return;
    }
    req._tx.set({ [SKIP_VAR]: 'true' });
    req._migrationModeSkipSet = true;
    log.debug?.(`change tracking skipped for ${req.event} ${req.target?.name}`);
  });

  db.after(['INSERT', 'UPDATE', 'DELETE'], async (_, req) => {
    if (!req?._migrationModeSkipSet) return;
    try {
      req._tx?.set?.({ [SKIP_VAR]: 'false' });
    } finally {
      delete req._migrationModeSkipSet;
    }
  });

  log.info?.('migration-mode handler registered on cds.db');
}
