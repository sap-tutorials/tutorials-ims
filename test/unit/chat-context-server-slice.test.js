import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

cds.test('serve', '--project', '.', '--in-memory');

const FIXTURE_HTML = `
<main class="tutorial-body">
  <section class="step" data-step-number="1"><h2 class="step-title">Alpha</h2><p>ALPHA_MARKER</p></section>
  <section class="step" data-step-number="2"><h2 class="step-title">Bravo</h2><p>BRAVO_MARKER</p></section>
</main>`;

const NS = 'com.sap.developers.ims';

describe('chat-context server-side slicer fallback', () => {
  let buildSystemPrompt;

  beforeAll(async () => {
    const { ContentManifest, ContentFiles } = cds.entities(NS);
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE'
    });
    await INSERT.into(ContentFiles).entries({
      version: 1,
      slug: 'cx-tut',
      content: gzipSync(Buffer.from(FIXTURE_HTML)),
      mimeType: 'text/html'
    });
    ({ buildSystemPrompt } = await import('../../srv/lib/chat-context.js'));
  });

  it('populates currentStepText from slicer when client omits it', async () => {
    const prompt = await buildSystemPrompt({ kind: 'tutorial', slug: 'cx-tut', currentStep: 2 }, {});
    expect(prompt).toContain('BRAVO_MARKER');
    expect(prompt).not.toContain('ALPHA_MARKER');
  });

  it('does not re-slice when client provides currentStepText', async () => {
    const prompt = await buildSystemPrompt({
      kind: 'tutorial', slug: 'cx-tut', currentStep: 2, currentStepText: 'CLIENT_SUPPLIED_TEXT'
    }, {});
    expect(prompt).toContain('CLIENT_SUPPLIED_TEXT');
    expect(prompt).not.toContain('BRAVO_MARKER');
  });

  it('is a no-op without slug or currentStep', async () => {
    const prompt = await buildSystemPrompt({ kind: 'tutorial' }, {});
    expect(prompt).not.toContain('BRAVO_MARKER');
  });
});
