'use strict';
// One-off probe: measure how many REPLACE/STRIP records already have their new
// value in prod (i.e. were committed before the crash) vs still at oldValue.
const cds = require('@sap/cds');
const { AUDIT_MAP, NS } = require('./fields.cjs');
const { records } = require('../../btp-audit/changeset.json');
const META = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const ents = cds.entities(NS);
  let applied = 0, pending = 0, drift = 0, missing = 0;
  const appliedList = [], driftList = [];
  for (const r of records) {
    if (r.action !== 'REPLACE' && r.action !== 'STRIP_PREFIX') continue;
    const m = META[r.entity];
    const row = await db.run(SELECT.one.from(ents[m.entity]).columns(m.keyField, r.field).where({ [m.keyField]: r.key }));
    if (!row) { missing++; continue; }
    const cur = row[r.field];
    if (cur === r.newValue) { applied++; appliedList.push(`${r.entity}/${r.field} …${r.key.slice(-4)}`); }
    else if (cur === r.oldValue) { pending++; }
    else { drift++; driftList.push(`${r.entity}/${r.field} …${r.key.slice(-4)}`); }
  }
  console.log('APPLIED (new value live in prod):', applied);
  console.log('PENDING (still old value):', pending);
  console.log('DRIFT (neither old nor new):', drift);
  console.log('MISSING row:', missing);
  if (appliedList.length) console.log('\napplied fields:\n  ' + appliedList.join('\n  '));
  if (driftList.length) console.log('\ndrift fields:\n  ' + driftList.join('\n  '));
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
