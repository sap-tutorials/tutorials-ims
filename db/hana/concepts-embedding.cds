// HANA-only: stored calculated element for Concepts.embeddingVec.
//
// On HANA profiles (hybrid / production) this annotate appends
// GENERATED ALWAYS AS to the embeddingVec column definition, turning
// it into a DB-computed column driven by VECTOR_EMBEDDING.  SQLite
// (development / unit tests) sees no annotation and keeps the plain
// Vector(1536) column, still written by the Node-side backfill job.
//
// The SQL expression is exactly equivalent to the Node join logic at
// srv/jobs/concept-embedding-backfill.js:116:
//   [name, description].filter(Boolean).join(' — ')
// i.e. NULL-safe COALESCE+CASE concat: empty/NULL parts dropped, ' — '
// separator inserted only when both name and description are present.
// No TRIM needed — the COALESCE+CASE form is already identical.
// Expression verified against live DEV HANA in spike #3114:
// non-null REAL_VECTOR(1536), cosine ≈ 1.0 vs Node output.
//
// Remote source TUTORIALS_AICORE resolves 'text-embedding-3-small' via
// the PSE + sapgenaihub wiring documented in
// docs/developers/operations/hana-aicore-embeddings.md.

using { com.sap.developers.ims.Concepts } from '../knowledge-graph';

annotate Concepts:embeddingVec with @sql.append: `GENERATED ALWAYS AS (VECTOR_EMBEDDING(COALESCE(name,'') || CASE WHEN name IS NOT NULL AND LENGTH(name)>0 AND description IS NOT NULL AND LENGTH(description)>0 THEN ' — ' ELSE '' END || COALESCE(description,''), 'DOCUMENT', 'text-embedding-3-small', TUTORIALS_AICORE))`;
