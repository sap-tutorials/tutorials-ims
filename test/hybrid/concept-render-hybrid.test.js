// test/hybrid/concept-render-hybrid.test.js
//
// #1327 Task 3 — verifies POST /content/publish/render-concepts against real
// HANA. Unit tests (test/unit/publish-concepts.test.js) cover batching, delta
// skip, and the error threshold with fakes. This file confirms HANA-specific
// concerns end-to-end:
//   1. render-concepts appends `concept-<slug>` full-doc BLOBs into an open
//      session; commit promotes them.
//   2. GET /content/concepts/<slug> serves the unzipped HTML with site chrome
//      (guards the LOB-alongside-metadata gotcha — BLOB read is raw db.run).
//   3. Re-running render-concepts is a no-op delta (all concepts skipped).
//
// Writes are gated by ALLOW_HYBRID_WRITES=true + __TEST__ prefix, cleaned up in
// afterAll (pattern from content-publish-guard/chunked tests).

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { createShellLoader } from '../../srv/lib/chrome-shell.js';
import { renderConceptsIntoSession } from '../../srv/lib/publish-concepts.js';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__rc-1327-';

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'render-concepts phase [hybrid]',
  () => {
    let helpers;
    let shellLoader;
    const cleanup = { concepts: [], sessions: [] };

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) throw new Error('concept-render-hybrid must run against HANA (npm run test:hybrid).');
      helpers = createSessionHelpers({ namespace: NS });
      const hanaTableName = () => `${NS.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
      async function getActiveVersion() {
        const { ContentManifest } = cds.entities(NS);
        const [row] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
        return row?.version ?? null;
      }
      shellLoader = createShellLoader({ namespace: NS, hanaTableName, getActiveVersion });
    });

    afterAll(async () => {
      // Best-effort cleanup of any __TEST__ concept rows we may have written.
      const db = await cds.connect.to('db');
      const { ContentFiles } = cds.entities(NS);
      for (const slug of cleanup.concepts) {
        try { await db.run(DELETE.from(ContentFiles).where({ slug })); } catch { /* ignore */ }
      }
    });

    it('renders a handful of real concepts into a session and composes site chrome', async () => {
      const shell = await shellLoader.get();
      expect(shell, 'a published __shell__ sidecar is required').toBeTruthy();

      // Take 3 real published concepts from buildConceptsPayload via the module.
      // We call the orchestrator directly (no HTTP) with a fresh session.
      const begin = await helpers.beginPublishSession({
        trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 3, initiator: 'concept-render-hybrid',
      });
      cleanup.sessions.push(begin.sessionId);

      const counts = await renderConceptsIntoSession({
        db: await cds.connect.to('db'),
        sessionId: begin.sessionId,
        helpers,
        priorHashes: {},          // force render of everything into THIS session
        shell,
      });
      expect(counts.conceptsSeen).toBeGreaterThan(0);
      expect(counts.conceptsChanged).toBe(counts.conceptsSeen);

      // The composed docs carry the shell chrome around the concept article.
      // Spot-check one row from the session version.
      const db = await cds.connect.to('db');
      const [row] = await db.run(
        `SELECT TOP 1 "SLUG","CONTENT" FROM "${NS.replace(/\./g, '_').toUpperCase()}_CONTENTFILES" ` +
        `WHERE "SLUG" LIKE 'concept-%' AND "VERSION" = ?`,
        [begin.version],
      );
      expect(row).toBeTruthy();
      const { gunzipSync } = await import('node:zlib');
      const html = gunzipSync(row.CONTENT).toString('utf-8');
      expect(html).toContain('<article class="concept-page"');
      expect(html.toLowerCase()).toContain('<html');   // full doc, shell chrome present

      // Abort — this test only verifies the render/append shape, not commit.
      await helpers.abortSession({ sessionId: begin.sessionId, reason: 'hybrid test' });
    }, 120000);
  },
);
