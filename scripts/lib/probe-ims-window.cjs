#!/usr/bin/env node
/**
 * scripts/lib/probe-ims-window.cjs
 *
 * Diagnostic: measure source-HANA connect time and count how many
 * IMS_TASK_RECORD rows fall in the delta window (UPDATED_AT > SINCE).
 * Read-only. Used to sanity-check why the delta migrator's opening range
 * probe is slow / how big the backfill actually is.
 *
 * Env: IMS_HANA_CREDENTIALS = {host,port,user,password,schema}
 * Args: [--since <iso>]  default 2026-07-22T13:14:40.859Z
 */
'use strict';

const hdb = require('hdb');

const SINCE = (() => {
  const i = process.argv.indexOf('--since');
  return i >= 0 ? process.argv[i + 1] : '2026-07-22T13:14:40.859Z';
})();

const c = JSON.parse(process.env.IMS_HANA_CREDENTIALS || 'null');
if (!c) { console.error('Set IMS_HANA_CREDENTIALS'); process.exit(2); }

const client = hdb.createClient({
  host: c.host, port: parseInt(c.port, 10), user: c.user, password: c.password, useTLS: true,
});

const t0 = Date.now();
client.connect((err) => {
  if (err) { console.error('CONNECT FAIL:', err.message); process.exit(1); }
  console.log(`connected in ${Date.now() - t0} ms`);
  const sql =
    `SELECT COUNT(*) AS "C", MIN("ID") AS "LO", MAX("ID") AS "HI" ` +
    `FROM "${c.schema}"."IMS_TASK_RECORD" WHERE "UPDATED_AT" > ?`;
  client.prepare(sql, (perr, stmt) => {
    if (perr) { console.error('PREPARE FAIL:', perr.message); process.exit(1); }
    stmt.exec([SINCE], (eerr, rows) => {
      if (eerr) { console.error('QUERY FAIL:', eerr.message); process.exit(1); }
      const r = rows[0];
      console.log(`window (UPDATED_AT > ${SINCE}): ${r.C} rows, ID ${r.LO}..${r.HI}`);
      console.log(`total elapsed ${Date.now() - t0} ms`);
      client.end();
    });
  });
});
