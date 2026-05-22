import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { ANALYTICS_SCHEMA as S } from './admin-analytics-schema.js';

function _piiCheck(field) {
  if (S.pii_denylist.includes(field)) {
    const e = new Error(`pii_denied: ${field}`);
    e.code = 'pii_denied';
    throw e;
  }
}

// Defense-in-depth: verify the dimension's underlying column or association path
// segments are not PII, regardless of how schema authors named the dimension itself.
function _piiCheckDimension(dim) {
  if (!dim) return;
  if (dim.column) _piiCheck(dim.column);
  if (dim.path) for (const seg of dim.path.split('.')) _piiCheck(seg);
}

export function _validatePlanOnly(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('unknown_field: plan');
  const fact = S.facts[plan.fact];
  if (!fact) { const e = new Error(`unknown_field: fact=${plan.fact}`); e.code = 'unknown_field'; throw e; }

  const groupBy = Array.isArray(plan.groupBy) ? plan.groupBy : [];
  for (const g of groupBy) {
    _piiCheck(g);
    if (!S.dimensions[g]) { const e = new Error(`unknown_field: dimension=${g}`); e.code = 'unknown_field'; throw e; }
    _piiCheckDimension(S.dimensions[g]);
  }

  const measures = Array.isArray(plan.measures) && plan.measures.length ? plan.measures : ['count'];
  for (const m of measures) {
    if (!S.measures[m]) { const e = new Error(`unknown_field: measure=${m}`); e.code = 'unknown_field'; throw e; }
  }

  const filters = Array.isArray(plan.filters) ? plan.filters : [];

  // tag dimension uses a multi-source fanout that cannot apply filters; reject early.
  const hasTagDim = groupBy.includes('tag') || filters.some(f => f.field === 'tag');
  if (hasTagDim && filters.length > 0) {
    const e = new Error('unknown_field: tag dimension does not support filters in this version');
    e.code = 'unknown_field';
    throw e;
  }

  for (const f of filters) {
    _piiCheck(f.field);
    const dim = S.dimensions[f.field];
    if (!dim) { const e = new Error(`unknown_field: filter.field=${f.field}`); e.code = 'unknown_field'; throw e; }
    _piiCheckDimension(dim);
    const op = S.filterOps[f.op];
    if (!op || !op.kinds.includes(dim.kind)) { const e = new Error(`unknown_field: filter.op=${f.op}`); e.code = 'unknown_field'; throw e; }
    if (f.op === 'sinceDays') {
      const n = Number(f.value);
      if (!Number.isFinite(n) || n < 1 || n > 3650) { const e = new Error('invalid_value: sinceDays'); e.code = 'invalid_value'; throw e; }
    }
    if (f.op === 'between') {
      if (!Array.isArray(f.value) || f.value.length !== 2) { const e = new Error('invalid_value: between'); e.code = 'invalid_value'; throw e; }
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length) { const e = new Error('invalid_value: in'); e.code = 'invalid_value'; throw e; }
    }
    if (['equals','contains'].includes(f.op)) {
      const t = typeof f.value;
      if (t !== 'string' && t !== 'number') { const e = new Error('invalid_value: scalar'); e.code = 'invalid_value'; throw e; }
    }
  }

  const limit = Math.min(Math.max(1, Number(plan.limit) || 25), S.MAX_LIMIT);
  return { fact: plan.fact, groupBy, measures, filters, limit };
}

function _hashUser(id) {
  return createHash('sha256').update(String(id || 'anon')).digest('hex');
}

function _buildCQN(v) {
  const fact = S.facts[v.fact];
  const cqn = { SELECT: { from: { ref: [fact.source] }, columns: [], where: [], groupBy: [] } };

  for (const g of v.groupBy) {
    const dim = S.dimensions[g];
    let expr;
    if (dim.kind === 'column')           expr = { ref: [dim.column] };
    else if (dim.kind === 'assoc')       expr = { ref: dim.path.split('.') };
    else if (dim.kind === 'task-lookup') expr = { ref: [dim.taskType.toLowerCase(), dim.display] };
    // date-trunc dims are NOT handled here — they go through _runDateTruncAggregation
    // because HANA strict-SQL rejects to_varchar(col, fmt) wrapped in SELECT/GROUP BY
    // even when both expressions are textually identical; CDS's CQN compiler emits
    // the inner column ref at an intermediate stage that HANA flags as ungrouped.
    // Push the EXPRESSION into groupBy, not the column alias. CDS resolves
    // `{ ref: [...] }` against entity elements; an alias is not an element of
    // the table and HANA rejects it. SQLite accepts alias-grouping silently —
    // which is why unit tests pass and prod doesn't.
    cqn.SELECT.columns.push({ ...expr, as: g });
    cqn.SELECT.groupBy.push(expr);
  }

  cqn.SELECT.columns.push({ func: 'count', args: ['*'], as: 'count' });
  cqn.SELECT.columns.push({ func: 'count', args: [{ ref: ['user_ID'] }], distinct: true, as: 'distinctUsers' });

  const baseFilter = fact.baseFilter || {};
  for (const [k, val] of Object.entries(baseFilter)) {
    if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
    cqn.SELECT.where.push({ ref: [k] }, '=', { val });
  }

  for (const f of v.filters) {
    const dim = S.dimensions[f.field];
    if (dim.kind === 'date-trunc' && f.op === 'sinceDays') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push(
        { ref: [dim.column] }, '>=',
        { func: 'add_days', args: [{ func: 'current_date', args: [] }, { val: -Number(f.value) }] },
      );
    } else if (dim.kind === 'date-trunc' && f.op === 'between') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ ref: [dim.column] }, '>=', { val: f.value[0] }, 'and', { ref: [dim.column] }, '<=', { val: f.value[1] });
    } else if (f.op === 'equals') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ ref }, '=', { val: f.value });
    } else if (f.op === 'in') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ ref }, 'in', { list: f.value.map(v => ({ val: v })) });
    } else if (f.op === 'contains') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ func: 'contains', args: [{ ref }, { val: String(f.value) }] });
    }
  }

  cqn.SELECT.limit = { rows: { val: v.limit } };
  cqn.SELECT.orderBy = [{ ref: ['count'], sort: 'desc' }];
  return cqn;
}

async function _runTagFanout(v, dbi) {
  const NS = 'com.sap.developers.ims.';
  const sources = [NS + 'TutorialTags', NS + 'MissionTags', NS + 'GroupTags'];
  const results = [];
  for (const src of sources) {
    const cqn = {
      SELECT: {
        from: { ref: [src] },
        columns: [
          { ref: ['tag'], as: 'tag' },
          { func: 'count', args: ['*'], as: 'count' },
          { func: 'count', args: [{ ref: ['user_ID'] }], distinct: true, as: 'distinctUsers' },
        ],
        groupBy: [{ ref: ['tag'] }],
      },
    };
    const rows = await dbi.run(cqn).catch(err => {
      cds.log('analytics').warn(`tag fanout error on ${src}`, err.message);
      return [];
    });
    results.push(...rows);
  }
  const byTag = new Map();
  for (const r of results) {
    const cur = byTag.get(r.tag) || { tag: r.tag, count: 0, distinctUsers: 0 };
    cur.count += Number(r.count) || 0;
    cur.distinctUsers += Number(r.distinctUsers) || 0;
    byTag.set(r.tag, cur);
  }
  const merged = [...byTag.values()].sort((a, b) => b.count - a.count).slice(0, v.limit);
  return merged;
}

function _isoWeekKey(d) {
  // ISO 8601 week: Monday-start, week containing Jan 4 is week 1.
  // Format 'YYYY-WW' matches HANA's 'IYYY-IW' string format.
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((u - yearStart) / 86400000 + 1) / 7);
  return `${u.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function _bucketDate(value, unit) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (unit === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return _isoWeekKey(d);
}

// Date-trunc aggregation runs in JS rather than the database. HANA's HEX
// engine rejects to_varchar(col, fmt) wrapped identically in SELECT and
// GROUP BY ("$T.COMPLETIONDATE invalid in select list"); SQLite accepts it.
// Following the _runTagFanout precedent: fetch raw rows + bucket in JS.
async function _runDateTruncAggregation(v, dbi) {
  const fact = S.facts[v.fact];
  const dateColumns = new Set();
  for (const g of v.groupBy) {
    const dim = S.dimensions[g];
    if (dim.kind === 'date-trunc') dateColumns.add(dim.column);
  }

  const cqn = { SELECT: { from: { ref: [fact.source] }, columns: [], where: [] } };
  for (const col of dateColumns) cqn.SELECT.columns.push({ ref: [col], as: col });
  for (const g of v.groupBy) {
    const dim = S.dimensions[g];
    if (dim.kind === 'date-trunc') continue;
    let expr;
    if (dim.kind === 'column')           expr = { ref: [dim.column] };
    else if (dim.kind === 'assoc')       expr = { ref: dim.path.split('.') };
    else if (dim.kind === 'task-lookup') expr = { ref: [dim.taskType.toLowerCase(), dim.display] };
    cqn.SELECT.columns.push({ ...expr, as: g });
  }
  cqn.SELECT.columns.push({ ref: ['user_ID'], as: 'user_ID' });

  const baseFilter = fact.baseFilter || {};
  for (const [k, val] of Object.entries(baseFilter)) {
    if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
    cqn.SELECT.where.push({ ref: [k] }, '=', { val });
  }
  for (const f of v.filters) {
    const dim = S.dimensions[f.field];
    if (dim.kind === 'date-trunc' && f.op === 'sinceDays') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push(
        { ref: [dim.column] }, '>=',
        { func: 'add_days', args: [{ func: 'current_date', args: [] }, { val: -Number(f.value) }] },
      );
    } else if (dim.kind === 'date-trunc' && f.op === 'between') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      cqn.SELECT.where.push({ ref: [dim.column] }, '>=', { val: f.value[0] }, 'and', { ref: [dim.column] }, '<=', { val: f.value[1] });
    } else if (f.op === 'equals') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ ref }, '=', { val: f.value });
    } else if (f.op === 'in') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ ref }, 'in', { list: f.value.map(v => ({ val: v })) });
    } else if (f.op === 'contains') {
      if (cqn.SELECT.where.length) cqn.SELECT.where.push('and');
      const ref = dim.kind === 'assoc'        ? dim.path.split('.')
                : dim.kind === 'task-lookup'  ? [dim.taskType.toLowerCase(), dim.display]
                : [dim.column];
      cqn.SELECT.where.push({ func: 'contains', args: [{ ref }, { val: String(f.value) }] });
    }
  }
  // Cap raw fetch so an unfiltered query can't exhaust memory; 100k rows
  // is well above any expected per-window completion volume.
  cqn.SELECT.limit = { rows: { val: 100000 } };

  const rows = await dbi.run(cqn);

  const buckets = new Map();
  for (const row of rows) {
    const key = {};
    for (const g of v.groupBy) {
      const dim = S.dimensions[g];
      key[g] = dim.kind === 'date-trunc' ? _bucketDate(row[dim.column], dim.unit) : row[g];
    }
    if (Object.values(key).some(x => x == null)) continue;
    const k = JSON.stringify(key);
    let cur = buckets.get(k);
    if (!cur) { cur = { ...key, count: 0, _users: new Set() }; buckets.set(k, cur); }
    cur.count++;
    if (row.user_ID != null) cur._users.add(row.user_ID);
  }

  const out = [...buckets.values()].map(b => {
    const { _users, ...rest } = b;
    return { ...rest, distinctUsers: _users.size };
  });
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, v.limit);
}

export async function runAnalyticsQuery({ plan, db, user, log }) {
  const start = Date.now();
  const v = _validatePlanOnly(plan);
  const dbi = db || cds.db;
  const usesTag = v.groupBy.includes('tag') || v.filters.some(f => f.field === 'tag');
  const usesDateTrunc = v.groupBy.some(g => S.dimensions[g].kind === 'date-trunc');

  let rawRows;
  if (usesTag) {
    rawRows = await _runTagFanout(v, dbi);
  } else if (usesDateTrunc) {
    rawRows = await _runDateTruncAggregation(v, dbi);
  } else {
    rawRows = await dbi.run(_buildCQN(v));
  }

  const k = S.K_ANON_MIN;
  let suppressedCount = 0;
  let rows;
  if (v.groupBy.length === 0) {
    const single = rawRows[0] || { count: 0, distinctUsers: 0 };
    if (Number(single.distinctUsers) < k) { rows = []; suppressedCount = 1; }
    else rows = [single];
  } else {
    rows = [];
    for (const r of rawRows) {
      if (Number(r.distinctUsers) < k) { suppressedCount++; continue; }
      rows.push(r);
    }
  }

  if (!v.measures.includes('distinctUsers')) {
    rows = rows.map(r => { const { distinctUsers, ...rest } = r; return rest; });
  }

  const audit = log || cds.log('chat');
  audit.info('analyticsQuery', {
    userHash: _hashUser(user?.id),
    fact: v.fact,
    dimensions: v.groupBy,
    filters: v.filters.map(f => ({ field: f.field, op: f.op })),
    totalRows: rawRows.length,
    suppressedCount,
    durationMs: Date.now() - start,
  });

  return { plan: v, rows, suppressedCount, totalRows: rawRows.length, kAnonThreshold: k };
}
