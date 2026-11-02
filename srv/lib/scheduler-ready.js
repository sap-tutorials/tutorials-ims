let _ready = false;

export function markSchedulerReady() {
  _ready = true;
}

export function isSchedulerReady() {
  return _ready;
}

export function _resetForTests() {
  _ready = false;
}

export function computeReadiness({ schedulerArmed, dbOk }) {
  const ready = schedulerArmed && dbOk;
  return {
    ready,
    status: ready ? 'ready' : 'not-ready',
    scheduler: schedulerArmed ? 'armed' : 'pending',
    db: dbOk ? 'connected' : 'error',
  };
}

/**
 * Dialect-safe liveness ping SQL for a cheap `cds.db.run(...)`.
 *
 * #2975 regression: HANA rejects a bare `SELECT 1` ("sql syntax error") — it
 * requires `SELECT 1 FROM DUMMY`. SQLite rejects `FROM DUMMY`. The original
 * /health/ready probe hardcoded `SELECT 1`, so dbOk was ALWAYS false on HANA,
 * /health/ready stayed 503, and CF's startup health gate crash-looped the app
 * on every deploy. (The integration test ran on in-memory SQLite, where bare
 * `SELECT 1` works, so it never caught this.)
 *
 * @param {string} [kind] db kind, defaults to cds.db.kind at call sites
 * @returns {string}
 */
export function dbPingSql(kind) {
  return kind === 'hana' ? 'SELECT 1 FROM DUMMY' : 'SELECT 1';
}
