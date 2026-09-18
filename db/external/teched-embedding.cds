// db/external/teched-embedding.cds
//
// Issue #2312, Unit 5 — semantic-search vectors for TechEd sessions.
//
// Dual-column embedding convention (mirrors the ApiDocs/Samples/Devtoberfest
// `extend` blocks in db/external-content.cds):
//   embedding    — raw Float32-LE BLOB, the SQLite unit-test cosine path.
//   embeddingVec — HANA REAL_VECTOR, the COSINE_SIMILARITY production path.
//
// Kept in its own file (NOT db/external/teched.cds, the FOUNDATION file) so the
// embedding concern is separable; loaded as a side-effect `using` from
// db/external-content.cds. Both columns are nullable until the freshness-corpus
// embedding backfill (srv/jobs/freshness-corpus-embedding-job.js) populates them.

using from './teched';

extend entity com.sap.developers.ims.external.TechEdSessions with {
  embedding    : LargeBinary;   // raw Float32 BLOB (SQLite unit-test path)
  embeddingVec : Vector(1536);  // HANA REAL_VECTOR (COSINE_SIMILARITY path)
}
