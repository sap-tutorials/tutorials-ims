// srv/lib/tag-md-format-handlers.js
//
// Reusable READ handlers for Tags projections that populate the virtual
// `mdFormat` field. Encapsulates:
//
//   * The after('READ') logic that fills mdFormat via applyMdFormat
//     (previously inline in author-service.js / admin-service.js).
//   * The before('READ') interceptor that rewrites $filter predicates on
//     the virtual `mdFormat` field to `titlePath` for SQL push-down and
//     stages a JS post-filter for after('READ') (#837).
//
// Attach with:
//     const { attachTagsMdFormatHandlers } = require('./lib/tag-md-format-handlers.js');
//     attachTagsMdFormatHandlers(this, 'Tags');
//
// The passed `entityName` is the projection name inside the current
// service (both AuthorService and AdminService expose it as 'Tags').

import { applyMdFormat } from './tag-md-format.js';
import {
  containsMdFormatRef,
  rewriteWhereForPushdown,
  buildRowMatcher,
} from './tag-md-format-filter.js';

// Upper bound on the SQL-side candidate scan when an mdFormat filter is
// active. 10K exceeds the current Tags row count (~10.5K on prod as of
// 2026-07-01, sampled via `hana-cli`) — kept generous to absorb near-term
// growth without silently truncating results. If the row count ever
// approaches this, consider materializing `mdFormat` as a real column.
const MD_FORMAT_SCAN_CEILING = 20000;

export function attachTagsMdFormatHandlers(srv, entityName) {
  srv.before('READ', entityName, (req) => {
    const where = req.query?.SELECT?.where;
    if (!containsMdFormatRef(where)) return;

    // Snapshot the original OData intent before we broaden the query.
    // We can't trust the DB's $count/$top/$skip once we widen the scan,
    // so stash them and recompute in after('READ').
    const originalWhere = where;
    const SELECT = req.query.SELECT;
    const stash = {
      where: originalWhere,
      limit: SELECT.limit ? { ...SELECT.limit } : undefined,
      // OData $count reaches us as `SELECT.count === true` and CAP
      // returns a `$count` header via req.query.SELECT.count. Both are
      // recomputed in after('READ').
      wantCount: SELECT.count === true,
      orderBy: SELECT.orderBy ? [...SELECT.orderBy] : undefined,
    };
    req._mdFormatFilterStash = stash;

    // Rewrite the filter for SQL push-down (mdFormat -> titlePath).
    SELECT.where = rewriteWhereForPushdown(originalWhere);

    // Broaden pagination to a bounded ceiling. after('READ') will apply
    // the exact predicate, then re-apply order, skip, top, count.
    SELECT.limit = { rows: { val: MD_FORMAT_SCAN_CEILING }, offset: { val: 0 } };
    if (SELECT.count) SELECT.count = false;
  });

  srv.after('READ', entityName, (rows, req) => {
    // Populate the virtual — every Tags read needs this.
    applyMdFormat(rows);

    const stash = req._mdFormatFilterStash;
    if (!stash) return;
    if (!Array.isArray(rows)) return;

    // Re-apply the ORIGINAL filter now that mdFormat is populated.
    const match = buildRowMatcher(stash.where);
    let filtered = rows.filter(match);

    // Re-apply orderBy. CAP's SELECT.orderBy is an array of `{ ref, sort }`.
    if (stash.orderBy && stash.orderBy.length > 0) {
      filtered.sort(makeSortComparator(stash.orderBy));
    }

    // Re-apply skip/top.
    const offset = numeric(stash.limit?.offset?.val, 0);
    const top = numeric(stash.limit?.rows?.val, undefined);
    const paged = top == null ? filtered.slice(offset) : filtered.slice(offset, offset + top);

    // Mutate rows in place so CAP serializes the pruned list. Splicing
    // into the same array preserves reference identity.
    rows.length = 0;
    for (const r of paged) rows.push(r);

    // Restore $count on the response envelope if the client asked for it.
    // CAP surfaces `$count` via req.res headers; the simplest reliable
    // route is req._counted (checked at odata layer) OR setting the
    // '$count' header directly. We set the header — visible to the
    // consumer even if the CAP internal `count` flag was cleared above.
    if (stash.wantCount && req.res) {
      try {
        req.res.setHeader('odata-count', String(filtered.length));
      } catch { /* header may already be sent in edge cases */ }
    }
    // Also expose as `$count` on the payload for tests / debugging.
    rows.$count = filtered.length;
  });
}

function numeric(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeSortComparator(orderBy) {
  return (a, b) => {
    for (const clause of orderBy) {
      const field = Array.isArray(clause.ref) ? clause.ref[0] : null;
      if (!field) continue;
      const av = a?.[field] ?? '';
      const bv = b?.[field] ?? '';
      let cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if ((clause.sort || '').toLowerCase() === 'desc') cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}
