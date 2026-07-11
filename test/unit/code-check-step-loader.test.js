import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1"><h2 class="step-title">Alpha</h2><p>Alpha body</p></section>
  <section class="step" data-step-number="2"><h2 class="step-title">Bravo</h2><p>Bravo body BODY_FOR_STEP_TWO</p></section>
  <section class="step" data-step-number="3"><h2 class="step-title">Charlie</h2><p>Charlie body</p></section>
</main>`;

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('code-check-step-loader retrofit', () => {
  let defaultLoadStepText;

  beforeAll(async () => {
    const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', publishedAt: new Date()
    });
    await INSERT.into(ContentFiles).entries({
      version: 1, slug: 'cc-tut', path: 'tutorials/cc-tut/index.html',
      mimeType: 'text/html', content: gzipSync(Buffer.from(FIXTURE_HTML))
    });
    ({ defaultLoadStepText } = await import('../../srv/lib/code-check-step-loader.js'));
  });

  it('returns ONLY step N text, not the whole tutorial', async () => {
    const text = await defaultLoadStepText('cc-tut', 2);
    expect(text).toContain('BODY_FOR_STEP_TWO');
    expect(text).not.toContain('Alpha body');
    expect(text).not.toContain('Charlie body');
  });

  it('returns null on missing slug', async () => {
    expect(await defaultLoadStepText('no-such-slug', 1)).toBeNull();
  });

  it('returns null on out-of-range stepNumber', async () => {
    expect(await defaultLoadStepText('cc-tut', 99)).toBeNull();
  });
});
