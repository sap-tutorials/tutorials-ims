import { describe, it, expect } from 'vitest';
import { BASE_URL, SRV_URL, fetchWithRetry } from './smoke.config.js';

/**
 * Regression smoke for the bug fixed in PR #324: every Done button on every
 * tutorial was rendered as escaped source code inside a <pre><code> block
 * because empty `{{ if }}` blocks above `<div class="step-actions">` in
 * hugo/layouts/shortcodes/tutorial-step.html leaked indented blank lines
 * that Goldmark interpreted as an indented code block (the shortcode is
 * invoked with percent-style `{{% %}}`, so its output is post-processed by
 * the markdown renderer).
 *
 * The published HTML lives in HANA (Hugo build → publish-content → BLOB), so
 * a regression in either the template or the publish path is observable from
 * the deployed page. We pull one tutorial and assert the Done buttons are
 * real DOM elements, not escaped text.
 */
describe('Done buttons render as real DOM (PR #324 regression)', () => {
  let knownSlug;

  it('GET /content/hashes returns a hash manifest', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/content/hashes`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const slugs = Object.keys(body);
    expect(slugs.length, 'no published content — cannot run Done-button smoke').toBeGreaterThan(0);
    knownSlug = slugs[0];
  });

  it('tutorial page has no <pre><code> blocks containing escaped step-actions HTML', async () => {
    if (!knownSlug) return;

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${knownSlug}/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Goldmark indented-code-block bug emits the entire <div class="step-actions">…</div>
    // as HTML-escaped text inside <pre><code>. Even one occurrence means the
    // template regression is back. Match the lowercased entity-escaped form
    // that Goldmark produces; quote the attribute value in &quot; so we don't
    // false-positive on legitimate `step-actions` mentions in tutorial prose.
    const ESCAPED_PATTERN = /<pre><code>&lt;div class=&quot;step-actions&quot;&gt;/;
    expect(html).not.toMatch(ESCAPED_PATTERN);
  });

  it('tutorial page renders at least one Done button as a real element', async () => {
    if (!knownSlug) return;

    const res = await fetchWithRetry(`${BASE_URL}/tutorials/${knownSlug}/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The Hugo minifier may strip attribute quotes, so accept both
    // `data-action="mark-done"` and `data-action=mark-done`. The button must
    // appear as a real DOM attribute on a real <button>, not as escaped text
    // inside <pre><code>.
    const RENDERED_PATTERN = /<button[^>]+data-action=("mark-done"|mark-done)[^>]*>/;
    expect(html).toMatch(RENDERED_PATTERN);
  });
});
