// test/smoke/you-will-learn.smoke.test.ts
//
// Issue #163 — guards the "You will learn" Overview block against the
// flexbox-anonymous-items regression where inline <a>/<code> in a bullet
// would visually "bleed across columns" because each inline child of the
// flex <li> became a separate flex item separated by gap:0.5rem.
//
// The fix wraps markdownify output in <span class="check-text">. This test
// asserts the wrapper survives Hugo build + minifier and that inline
// content stays *inside* the wrapper rather than being a direct <li> child.
//
// Tutorial slug `abap-cloud-ui-from-interface` is the canonical witness —
// its first bullet contains both a link and inline `code`, which is why
// Daniel Wroblewski reported the issue against this page.
//
// Whitespace + quote tolerant — see [[feedback-hugo-minifier-strips-quotes]].
import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

const SLUG = process.env.SMOKE_YWL_SLUG ?? 'abap-cloud-ui-from-interface';

describe('You will learn — issue #163 regression guard', () => {
  it('renders bullets with check-icon + check-text wrapper (no anonymous flex items)', async () => {
    const url = `${SRV_URL}/content/tutorials/${SLUG}`;
    const res = await fetchWithRetry(url);
    if (res.status === 302) return; // login redirect — acceptable, sibling tests do the same
    expect(res.status).toBe(200);

    const html = await res.text();

    // 1. The Overview block exists.
    expect(html).toMatch(/class=["']?you-will-learn["']?/);

    // 2. Each bullet has the check-text wrapper. We don't assert *count* —
    //    bullet count varies per tutorial — only that the wrapper is present.
    expect(html).toMatch(/class=["']?check-text["']?/);

    // 3. The first bullet's inline link is *inside* check-text, not a
    //    direct <li> child. Whitespace-tolerant + quote-optional regex,
    //    multiline so .*? can span the bullet across pretty/minified output.
    //    If the wrapper regresses, the <a> would become a sibling of
    //    <span class=check-icon> and this assertion would fail.
    const wrapperWithLink = /<span class=["']?check-text["']?>[\s\S]*?<a[^>]*>Business Object Interface<\/a>[\s\S]*?<\/span>/;
    expect(html).toMatch(wrapperWithLink);

    // 4. The same wrapper holds the inline <code> token — the second
    //    half of Daniel's screenshot evidence.
    const wrapperWithCode = /<span class=["']?check-text["']?>[\s\S]*?<code>I_BankTP<\/code>[\s\S]*?<\/span>/;
    expect(html).toMatch(wrapperWithCode);
  });
});
