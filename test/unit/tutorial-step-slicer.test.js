import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

cds.test('serve', '--project', '.', '--in-memory');

// Fixture: 3-step tutorial HTML in the Hugo-emitted shape.
const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1">
    <h2 class="step-title">Install CAP</h2>
    <p>Run <code>npm install -g @sap/cds-dk</code>.</p>
  </section>
  <section class="step" data-step-number="2">
    <h2 class="step-title">Init the project</h2>
    <p>Run <code>cds init bookshop</code>.</p>
  </section>
  <section class="step" data-step-number="3">
    <h2 class="step-title">Start the server</h2>
    <p>Run <code>cds watch</code>.</p>
  </section>
</main>`;

const NS = 'com.sap.developers.ims';

describe('tutorial-step-slicer', () => {
  let sliceStep, sliceAllSteps, invalidateSlug;

  beforeAll(async () => {
    // In-memory caching store so the `caching` service resolves — the slice
    // cache is now backed by cds-caching, not lru-cache (issue #1180).
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.caching = { impl: 'cds-caching', namespace: 'slicer-test', store: 'memory' };
    await cds.connect.to('caching');

    const { ContentManifest, ContentFiles } = cds.entities(NS);
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE'
    });
    await INSERT.into(ContentFiles).entries({
      version: 1,
      slug: 'hello-cap',
      content: gzipSync(Buffer.from(FIXTURE_HTML)),
      mimeType: 'text/html'
    });
    const mod = await import('../../srv/lib/tutorial-step-slicer.js');
    ({ sliceStep, sliceAllSteps, invalidateSlug } = mod);
    mod._resetConnection();
  });

  it('returns the correct step for a valid stepNumber', async () => {
    const slice = await sliceStep('hello-cap', 2);
    expect(slice).not.toBeNull();
    expect(slice.stepTitle).toBe('Init the project');
    expect(slice.html).toContain('cds init bookshop');
    expect(slice.text).toContain('cds init bookshop');
    expect(slice.text).not.toContain('<code>');
    expect(slice.totalSteps).toBe(3);
  });

  it('a cache hit returns an identical shape (Map rebuilt from the serialized entries array, #1180)', async () => {
    // The value is stored as a serializable entries array, NOT a live Map — a
    // production store (Redis/HANA) cannot round-trip a Map. This asserts the
    // hit path rebuilds the Map so sliceStep/sliceAllSteps behave identically
    // on a hit vs. a miss.
    const first = await sliceStep('hello-cap', 3);   // miss → parse + cache
    const second = await sliceStep('hello-cap', 3);  // hit  → rebuilt from entries
    expect(second).toEqual(first);
    expect(second.stepTitle).toBe('Start the server');
    // sliceAllSteps iterates the rebuilt Map on a hit.
    const meta = await sliceAllSteps('hello-cap');
    expect(meta).toEqual([
      { stepNumber: 1, title: 'Install CAP' },
      { stepNumber: 2, title: 'Init the project' },
      { stepNumber: 3, title: 'Start the server' }
    ]);
  });

  it('returns null for a step out of range', async () => {
    expect(await sliceStep('hello-cap', 99)).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    expect(await sliceStep('no-such-slug', 1)).toBeNull();
  });

  it('sliceAllSteps returns metadata only in order', async () => {
    const meta = await sliceAllSteps('hello-cap');
    expect(meta).toEqual([
      { stepNumber: 1, title: 'Install CAP' },
      { stepNumber: 2, title: 'Init the project' },
      { stepNumber: 3, title: 'Start the server' }
    ]);
  });

  it('invalidateSlug clears the cache for that slug', async () => {
    await sliceStep('hello-cap', 1); // warm cache
    await invalidateSlug('hello-cap');
    // A second call should re-hit the DB — assert by mutating and confirming re-read.
    const { ContentFiles } = cds.entities(NS);
    await UPDATE(ContentFiles).where({ slug: 'hello-cap' }).with({
      content: gzipSync(Buffer.from(FIXTURE_HTML.replace('Install CAP', 'INSTALL CAP')))
    });
    const slice = await sliceStep('hello-cap', 1);
    expect(slice.stepTitle).toBe('INSTALL CAP');
  });
});
