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
    if (dim.kind === 'column')        cqn.SELECT.columns.push({ ref: [dim.column], as: g });
    else if (dim.kind === 'assoc')    cqn.SELECT.columns.push({ ref: dim.path.split('.'), as: g });
    else if (dim.kind === 'date-trunc') {
      cqn.SELECT.columns.push({ func: 'series_round', args: [{ ref: [dim.column] }, { val: dim.unit === 'month' ? 'INTERVAL 1 MONTH' : 'INTERVAL 1 WEEK' }], as: g });
    } else if (dim.kind === 'task-lookup') {
      cqn.SELECT.columns.push({ ref: [dim.taskType.toLowerCase(), dim.display], as: g });
    }
    cqn.SELECT.groupBy.push({ ref: [g] });
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

export async function runAnalyticsQuery({ plan, db, user, log }) {
  const start = Date.now();
  const v = _validatePlanOnly(plan);
  const dbi = db || cds.db;
  const usesTag = v.groupBy.includes('tag') || v.filters.some(f => f.field === 'tag');

  let rawRows;
  if (usesTag) {
    rawRows = await _runTagFanout(v, dbi);
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
