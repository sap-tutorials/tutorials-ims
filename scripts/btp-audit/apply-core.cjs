'use strict';
// Pure decision logic for the apply stage: no DB, no process calls — unit-testable.

const WRITABLE = new Set(['REPLACE', 'STRIP_PREFIX']);

function decideApply(record, currentValue) {
  if (!WRITABLE.has(record.action) || record.newValue == null) {
    return { status: 'skipped-action', write: false };
  }
  if (currentValue !== record.oldValue) {
    // Row changed since export, OR already applied. Distinguish the benign case.
    if (currentValue === record.newValue) return { status: 'skipped-no-change', write: false };
    return { status: 'skipped-concurrent-edit', write: false };
  }
  if (currentValue === record.newValue) return { status: 'skipped-no-change', write: false };
  return { status: 'applied', write: true };
}

function assertProdTarget(cfTargetText, expected) {
  const exp = expected || {
    org: process.env.BTP_AUDIT_PROD_ORG, space: process.env.BTP_AUDIT_PROD_SPACE,
  };
  const txt = String(cfTargetText || '');
  if (!exp.org || !txt.includes(exp.org)) {
    throw new Error(`cf target org mismatch: expected to contain "${exp.org}". Aborting prod write.`);
  }
  if (!exp.space || !new RegExp(`space:\\s*${exp.space}\\b`, 'i').test(txt)) {
    throw new Error(`cf target space mismatch: expected "${exp.space}". Aborting prod write.`);
  }
  return true;
}

module.exports = { decideApply, assertProdTarget, WRITABLE };
