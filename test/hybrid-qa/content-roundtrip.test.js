/**
 * Hybrid-qa content round-trip test.
 *
 * Exercises the compressed-BLOB write/read cycle against the QA HDI
 * (com.sap.developers.ims.qa namespace):
 *
 *   1. Publish an ACTIVE manifest (v1) and a single ContentFiles row
 *      keyed by slug `__TEST__qa-roundtrip` with gzip-compressed HTML.
 *   2. Read the BLOB back via raw SQL (mirrors the production serve
 *      handler — see srv/lib/content-store.js for the LOB-locator
 *      reasoning) and decompress it.
 *   3. Assert the decompressed HTML matches what we put in.
 *
 * Skipped unless ALLOW_HYBRID_WRITES=true. Cleans up its rows in afterAll.
 *
 * NOTE: this test goes directly to the bound DB rather than booting the
 * srv-qa Express handler, because the hybrid-qa vitest project does not
 * stand up an HTTP server. The DB-level round-trip is the load-bearing
 * piece (HANA BLOB locator behaviour); the HTTP wrapper is covered by
 * the existing content-service tests against the local CAP project.
 */

import cds from '@sap/cds';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const TEST_SLUG = '__TEST__qa-roundtrip';
const NAMESPACE = 'com.sap.developers.ims.qa';
const TABLE = 'COM_SAP_DEVELOPERS_IMS_QA_CONTENTFILES';
const HTML = '<html><body><h1>QA round-trip</h1></body></html>';

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true';

describe.skipIf(!writesAllowed)('hybrid-qa content round-trip', () => {
  let db;
  let testVersion;

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    if (!db) return;
    const { ContentFiles, ContentManifest } = cds.entities(NAMESPACE);
    try {
      await DELETE.from(ContentFiles).where({ slug: TEST_SLUG });
      if (testVersion !== undefined) {
        await DELETE.from(ContentManifest).where({ version: testVersion });
      }
    } catch (err) {
      // Cleanup best-effort — surface but don't fail the suite.
      console.warn('[hybrid-qa cleanup]', err.message);
    }
  });

  it('writes a compressed BLOB and reads it back via raw SQL', async () => {
    const { ContentFiles, ContentManifest } = cds.entities(NAMESPACE);

    // Pick a high test version that won't collide with real publishes.
    // The QA HDI is fresh per Task 26, but defensively read max+1.
    const [maxRow] = await db.run(
      `SELECT MAX("VERSION") AS V FROM "COM_SAP_DEVELOPERS_IMS_QA_CONTENTMANIFEST"`
    );
    testVersion = (maxRow?.V ?? 0) + 1000;

    const compressed = gzipSync(Buffer.from(HTML, 'utf-8'));
    const hash = createHash('sha256').update(HTML).digest('hex');

    await INSERT.into(ContentManifest).entries({
      version: testVersion,
      status: 'PUBLISHING',
      trigger: 'hybrid-qa-roundtrip-test',
      fileCount: 1,
      totalSizeBytes: HTML.length,
      changedSlugs: JSON.stringify([TEST_SLUG]),
      hugoVersion: 'test'
    });

    await INSERT.into(ContentFiles).entries({
      slug: TEST_SLUG,
      version: testVersion,
      content: compressed,
      contentHash: hash,
      sizeBytes: HTML.length,
      compressedBytes: compressed.length,
      mimeType: 'text/html'
    });

    // Mark active so it would be visible to the serve handler.
    await UPDATE(ContentManifest)
      .where({ version: testVersion })
      .set({ status: 'ACTIVE' });

    // Read BLOB back via raw SQL — same path the production serve handler
    // uses on HANA (CDS QL returns LOB locators that expire when mixed with
    // metadata columns; raw SQL returns a Buffer directly).
    const [blobRow] = await db.run(
      `SELECT TOP 1 "CONTENT", "CONTENTHASH" FROM "${TABLE}" WHERE "SLUG" = ? AND "VERSION" = ?`,
      [TEST_SLUG, testVersion]
    );

    expect(blobRow).toBeTruthy();
    expect(blobRow.CONTENTHASH).toBe(hash);

    const decompressed = gunzipSync(blobRow.CONTENT).toString('utf-8');
    expect(decompressed).toBe(HTML);
  });
});
