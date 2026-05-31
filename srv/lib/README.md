# srv/lib

Shared modules consumed by the CAP services in `srv/`.

## Analytics Builder modules (Phase 1, 2026-05-31)

- `analytics-sql-validator.cjs` — strict allowlist + SELECT-only validator on raw SQL. Used by `runSelectQuery`, `sampleDistinct`, and `exportSelectQuery`. Re-emits via Postgresql dialect for HANA compat.
- `query-spec-validator.cjs` — validates a QuerySpec (referential integrity, op/value compatibility, OR-group depth ≤ 4). Pure function. **Isomorphic** — re-exported via Vite alias for browser consumption in Phase 2.
- `spec-to-sql.cjs` — deterministic QuerySpec → HANA-flavoured SQL. Pure function. **Isomorphic** alongside `query-spec-validator.cjs`.
- `analytics-distinct-sample.js` — annotation-gated DISTINCT sampling for filter-chip dropdowns.
- `analytics-export-stream.js` — CSV streaming helpers (header/row escaping + truncation comments). Hard caps: 100k rows / 60s wall-clock.
- `analytics-history-writer.js` — small helper to insert into `AnalyticsQueryHistory` from `runSelectQuery`.
- `cds-type-to-hana.cjs` — maps CDS element types (e.g. `cds.String(255)`) to the precise HANA SQL type string (`NVARCHAR(255)`) returned by `listExposedEntities`.

## Other modules

(Existing — not re-documented here.)
