import { describe, it, expect } from 'vitest';
import { parseShell, composeShell, canonicalUrlFor, ShellMarkerError } from '../srv/lib/chrome-shell.js';

const SAMPLE_SHELL = `<!DOCTYPE html>
<html lang="en" data-page-kind="generic" data-page-slug="" data-page-title="">
<head><title></title><meta name="description" content=""></head>
<body><header>chrome</header>
<!-- MAIN -->
<footer>chrome-foot</footer></body></html>`;

describe('chrome-shell.parseShell', () => {
  it('splits cleanly on the MAIN marker', () => {
    const { before, after } = parseShell(SAMPLE_SHELL);
    expect(before).toContain('<header>chrome</header>');
    expect(after).toContain('<footer>chrome-foot</footer>');
    expect(before).not.toContain('<!-- MAIN -->');
    expect(after).not.toContain('<!-- MAIN -->');
  });

  it('throws ShellMarkerError when marker is missing', () => {
    expect(() => parseShell('<html><body>no marker</body></html>'))
      .toThrow(ShellMarkerError);
  });

  it('throws ShellMarkerError when marker appears twice', () => {
    const bad = SAMPLE_SHELL.replace('<footer>', '<!-- MAIN --><footer>');
    expect(() => parseShell(bad)).toThrow(ShellMarkerError);
  });
});

describe('chrome-shell.composeShell', () => {
  const parsed = parseShell(SAMPLE_SHELL);

  it('substitutes data-page-kind, data-page-slug, data-page-title, <title>, description', () => {
    const html = composeShell(parsed, '<main>BODY</main>', {
      kind: 'group',
      slug: 'group-foo',
      title: 'Foo Group',
      description: 'Desc',
    });
    expect(html).toContain('data-page-kind="group"');
    expect(html).toContain('data-page-slug="group-foo"');
    expect(html).toContain('data-page-title="Foo Group"');
    expect(html).toContain('<title>Foo Group</title>');
    expect(html).toContain('<meta name="description" content="Desc">');
    expect(html).toContain('<main>BODY</main>');
  });

  it('escapes HTML in attribute values', () => {
    const html = composeShell(parsed, '<main></main>', {
      kind: 'group',
      slug: 'group-x',
      title: '<script>alert(1)</script>',
      description: '"quote"',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quote&quot;');
  });

  it('preserves chrome before and after the body verbatim', () => {
    const html = composeShell(parsed, '<main>X</main>', {
      kind: 'group', slug: 's', title: 't', description: 'd',
    });
    expect(html.indexOf('<header>chrome</header>')).toBeLessThan(html.indexOf('<main>X</main>'));
    expect(html.indexOf('<main>X</main>')).toBeLessThan(html.indexOf('<footer>chrome-foot</footer>'));
  });

  // #1291: the published _shell BLOB is Hugo-minified — quotes are stripped
  // from single-token attribute values and empty values collapse to a bare
  // attribute name. The substitution must still land, otherwise group/mission
  // pages ship the placeholder data-page-kind=generic / data-page-title=_shell.
  it('substitutes into a minified (unquoted-attr) shell', () => {
    const MINIFIED_SHELL =
      '<!DOCTYPE html><html lang=en data-theme=light data-page-kind=generic ' +
      'data-page-slug data-page-title=_shell data-page-tags>' +
      '<head><title></title><meta name=description content=""></head>' +
      '<body><header>chrome</header><!-- MAIN --><footer>foot</footer></body></html>';
    const parsedMin = parseShell(MINIFIED_SHELL);
    const html = composeShell(parsedMin, '<main>BODY</main>', {
      kind: 'group',
      slug: 'group-foo',
      title: 'Foo Group',
      description: 'Desc',
    });
    expect(html).toContain('data-page-kind="group"');
    expect(html).toContain('data-page-slug="group-foo"');
    expect(html).toContain('data-page-title="Foo Group"');
    expect(html).toContain('<title>Foo Group</title>');
    expect(html).toContain('<meta name="description" content="Desc">');
    // The placeholder must be gone, not merely supplemented.
    expect(html).not.toContain('data-page-kind=generic');
    expect(html).not.toContain('data-page-title=_shell');
    // Adjacent attributes must survive the substitution intact.
    expect(html).toContain('data-theme=light');
    expect(html).toContain('data-page-tags');
  });
});

// #1795: the _shell page is `robotsNoIndex: true` and canonicalises to
// /_shell/, so its baked SEO head (robots noindex, canonical, og:/twitter:
// title/description/url, all stamped "_shell") leaked onto every composed page
// (concepts + group/mission catalog). composeShell must rewrite them per page.
// The shell string below mirrors the live PROD minified forms verified
// 2026-08-14 (name=robots unquoted, content quoted; property="og:title"
// quoted; name=twitter:title unquoted; canonical rel + href unquoted).
const SEO_SHELL_MIN =
  '<!DOCTYPE html><html lang=en data-page-kind=generic data-page-slug data-page-title=_shell>' +
  '<head><title>_shell</title>' +
  '<meta name=description content="">' +
  '<link rel=canonical href=https://developers.sap.com/_shell/>' +
  '<meta name=robots content="noindex, nofollow">' +
  '<meta name=content-signal content="index=yes, ai-train=no, ai-search=yes">' +
  '<meta property="og:site_name" content="SAP Developer Center">' +
  '<meta property="og:title" content="_shell">' +
  '<meta property="og:description" content="Site default description.">' +
  '<meta property="og:url" content="https://developers.sap.com/_shell/">' +
  '<meta property="og:image" content="https://developers.sap.com/img/og-default.png">' +
  '<meta name=twitter:card content="summary_large_image">' +
  '<meta name=twitter:title content="_shell">' +
  '<meta name=twitter:description content="Site default description.">' +
  '</head><body><header>chrome</header><!-- MAIN --><footer>foot</footer></body></html>';

describe('chrome-shell.composeShell — SEO head rewrite (#1795)', () => {
  const parsed = parseShell(SEO_SHELL_MIN);

  it('rewrites robots noindex → indexable directive on a composed page', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'concept', slug: 'a2a-agent-protocol',
      title: 'A2A Protocol', description: 'Learn A2A.',
    });
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">');
    expect(html).not.toContain('noindex, nofollow');
  });

  it('rewrites canonical + og:url to the concept URL (no more /_shell/)', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'concept', slug: 'a2a-agent-protocol',
      title: 'A2A Protocol', description: 'Learn A2A.',
    });
    expect(html).toContain('<link rel="canonical" href="https://developers.sap.com/concepts/a2a-agent-protocol/">');
    expect(html).toContain('<meta property="og:url" content="https://developers.sap.com/concepts/a2a-agent-protocol/">');
    expect(html).not.toContain('href=https://developers.sap.com/_shell/');
    expect(html).not.toContain('content="https://developers.sap.com/_shell/"');
  });

  it('rewrites og:/twitter: title + description away from the _shell placeholder', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'concept', slug: 'a2a-agent-protocol',
      title: 'A2A Protocol', description: 'Learn A2A.',
    });
    expect(html).toContain('<meta property="og:title" content="A2A Protocol">');
    expect(html).toContain('<meta name="twitter:title" content="A2A Protocol">');
    expect(html).toContain('<meta property="og:description" content="Learn A2A.">');
    expect(html).toContain('<meta name="twitter:description" content="Learn A2A.">');
    expect(html).not.toContain('content="_shell"');
    // Untouched og tags survive.
    expect(html).toContain('<meta property="og:site_name" content="SAP Developer Center">');
    expect(html).toContain('<meta property="og:image" content="https://developers.sap.com/img/og-default.png">');
  });

  it('maps group/mission slugs to /tutorials/ and concepts-index to /concepts/', () => {
    const group = composeShell(parsed, '<main/>', { kind: 'group', slug: 'group-x', title: 'G', description: 'd' });
    expect(group).toContain('<link rel="canonical" href="https://developers.sap.com/tutorials/group-x/">');
    const idx = composeShell(parsed, '<main/>', { kind: 'concepts-index', slug: 'concepts', title: 'Concepts', description: 'd' });
    expect(idx).toContain('<link rel="canonical" href="https://developers.sap.com/concepts/">');
  });

  it('leaves the empty site-default social description when the page has none', () => {
    const html = composeShell(parsed, '<main/>', { kind: 'concept', slug: 's', title: 'T', description: '' });
    // og/twitter description keep the baked default rather than going empty.
    expect(html).toContain('<meta property="og:description" content="Site default description.">');
    // But the page still gets its title and a canonical.
    expect(html).toContain('<meta property="og:title" content="T">');
    expect(html).toContain('<link rel="canonical" href="https://developers.sap.com/concepts/s/">');
  });

  it('honors an explicit meta.canonicalUrl override', () => {
    expect(canonicalUrlFor({ kind: 'concept', slug: 's', canonicalUrl: 'https://x/y/' })).toBe('https://x/y/');
    expect(canonicalUrlFor({ kind: 'group', slug: 'group-x' })).toBe('https://developers.sap.com/tutorials/group-x/');
    expect(canonicalUrlFor({ kind: 'unknown', slug: 's' })).toBeNull();
  });

  it('leaves canonical + robots untouched on a shell that lacks those tags', () => {
    const bare = parseShell('<html><head><title></title></head><body><header>h</header><!-- MAIN --><footer>f</footer></body></html>');
    const html = composeShell(bare, '<main>B</main>', { kind: 'concept', slug: 's', title: 'T', description: 'd' });
    // No-op replaces — nothing added, body still composed.
    expect(html).toContain('<main>B</main>');
    expect(html).toContain('<title>T</title>');
    expect(html).not.toContain('canonical');
  });
});
