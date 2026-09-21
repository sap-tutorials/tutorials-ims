// test/content-publish-guard.test.js
// Public-namespace `-Contribution` publish guard (SQLite unit tests).
//
// appendToSession must:
//  1. accept a `sourceRepos` (Record<slug,string>) param,
//  2. persist `sourceRepo` on each written ContentFiles row, and
//  3. SKIP any slug whose sourceRepo ends in `-Contribution` when the
//     helper is bound to the PUBLIC namespace (com.sap.developers.ims),
//     reporting the skipped slugs as `blockedContributionSlugs`.
//
// The QA channel (namespace com.sap.developers.ims.qa) is a legitimate home
// for -Contribution content, so the guard is dormant there. Fail-safe: a slug
// with a null/absent/empty sourceRepo is NEVER blocked.
//
// Harness: the QA namespace has ZERO definitions in the main loadable model —
// it is a runtime-only remapping deployed by the srv-qa module. To exercise
// BOTH namespaces in one in-memory sqlite we load the prod model (db/) AND the
// narrow QA schema (db-qa/schema.cds, which re-declares the QA-namespaced
// entities against the same shared aspects) and deploy the merged model. Both
// `cds.entities('com.sap.developers.ims')` and `...ims.qa` then resolve, so a
// namespace-bound createSessionHelpers can run a real begin/append against
// either. (Same shared-aspect reuse as
// srv/__tests__/lib/content-store-skip-metadata.test.js.)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../srv/lib/content-publish-session.js';

const PUBLIC_NS = 'com.sap.developers.ims';
const QA_NS = 'com.sap.developers.ims.qa';

function html(s) {
  return gzipSync(
    Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8'),
  ).toString('base64');
}

async function beginAndAppend(helpers, { files, sourceRepos }) {
  const { sessionId } = await helpers.beginPublishSession({
    trigger: 'unit-test',
    hugoVersion: '0.147.0',
    expectedSlugCount: Object.keys(files).length,
    initiator: 'unit-test',
  });
  return helpers.appendToSession({ sessionId, files, sourceRepos });
}

function writtenList(res) {
  return res.writtenSlugs ?? res.slugs;
}

describe('public-namespace -Contribution publish guard', () => {
  let publicHelpers, qaHelpers;
  let PublicContentFiles, PublicContentManifest, PublicPipelineLog, PublicJobLocks;
  let QaContentFiles, QaContentManifest, QaPipelineLog, QaJobLocks;

  beforeAll(async () => {
    // Merge the prod model and the QA-namespaced schema, then deploy once so
    // both namespaces exist in the same in-memory sqlite.
    const model = await cds.load([
      path.resolve(process.cwd(), 'db'),
      path.resolve(process.cwd(), 'db-qa', 'schema.cds'),
    ]);
    await cds.deploy(model).to('sqlite::memory:');

    publicHelpers = createSessionHelpers({ namespace: PUBLIC_NS });
    qaHelpers = createSessionHelpers({ namespace: QA_NS });

    ({
      ContentFiles: PublicContentFiles,
      ContentManifest: PublicContentManifest,
      PipelineLog: PublicPipelineLog,
      JobLocks: PublicJobLocks,
    } = cds.entities(PUBLIC_NS));
    ({
      ContentFiles: QaContentFiles,
      ContentManifest: QaContentManifest,
      PipelineLog: QaPipelineLog,
      JobLocks: QaJobLocks,
    } = cds.entities(QA_NS));
  });

  beforeEach(async () => {
    await DELETE.from(PublicContentFiles);
    await DELETE.from(PublicContentManifest);
    await DELETE.from(PublicPipelineLog);
    await DELETE.from(PublicJobLocks);
    await DELETE.from(QaContentFiles);
    await DELETE.from(QaContentManifest);
    await DELETE.from(QaPipelineLog);
    await DELETE.from(QaJobLocks);
  });

  it('public namespace: skips -Contribution slug, writes normal slug', async () => {
    const res = await beginAndAppend(publicHelpers, {
      files: { 'good-slug': html('ok'), 'qa-slug': html('qa') },
      sourceRepos: {
        'good-slug': 'sap-tutorials/developer-advocates',
        'qa-slug': 'sap-tutorials/developer-advocates-Contribution',
      },
    });

    expect(res.blockedContributionSlugs).toEqual(['qa-slug']);
    expect(writtenList(res)).toContain('good-slug');
    expect(writtenList(res)).not.toContain('qa-slug');

    // The blocked slug must not have landed in ContentFiles; the good one must.
    const good = await SELECT.one.from(PublicContentFiles).where({ slug: 'good-slug' });
    const qa = await SELECT.one.from(PublicContentFiles).where({ slug: 'qa-slug' });
    expect(good, 'good-slug row written').toBeTruthy();
    expect(good.sourceRepo).toBe('sap-tutorials/developer-advocates');
    expect(qa, 'qa-slug row NOT written').toBeFalsy();
  });

  it('qa namespace: allows -Contribution slug', async () => {
    const res = await beginAndAppend(qaHelpers, {
      files: { 'qa-slug': html('qa') },
      sourceRepos: { 'qa-slug': 'sap-tutorials/developer-advocates-Contribution' },
    });

    expect(res.blockedContributionSlugs).toEqual([]);
    expect(writtenList(res)).toContain('qa-slug');

    const qa = await SELECT.one.from(QaContentFiles).where({ slug: 'qa-slug' });
    expect(qa, 'qa-slug row written under QA namespace').toBeTruthy();
    expect(qa.sourceRepo).toBe('sap-tutorials/developer-advocates-Contribution');
  });

  it('public namespace: null/absent sourceRepo is NOT blocked (fail-safe)', async () => {
    const res = await beginAndAppend(publicHelpers, {
      files: { 'legacy-slug': html('legacy') },
      sourceRepos: {}, // no repo known
    });

    expect(res.blockedContributionSlugs).toEqual([]);
    expect(writtenList(res)).toContain('legacy-slug');

    const legacy = await SELECT.one.from(PublicContentFiles).where({ slug: 'legacy-slug' });
    expect(legacy, 'legacy-slug row written').toBeTruthy();
    expect(legacy.sourceRepo, 'null sourceRepo persisted as null').toBeNull();
  });
});
