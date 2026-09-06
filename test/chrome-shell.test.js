import { describe, it, expect } from 'vitest';
import { parseShell, composeShell, canonicalUrlFor, buildBreadcrumbJsonLd, ShellMarkerError } from '../srv/lib/chrome-shell.js';

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

  it('derives the /puzzles/<slug>/ canonical for kind "puzzle" (#1914)', () => {
    expect(canonicalUrlFor({ kind: 'puzzle', slug: 'devtoberfest-2026-warmup' }))
      .toBe('https://developers.sap.com/puzzles/devtoberfest-2026-warmup/');
  });

  it('derives the /puzzles/ canonical for kind "puzzles-index" (#1914 index)', () => {
    expect(canonicalUrlFor({ kind: 'puzzles-index', slug: 'puzzles' }))
      .toBe('https://developers.sap.com/puzzles/');
  });

  it('derives the /channels/<slug>/ canonical for kind "channel" (channels-hub Phase 2)', () => {
    expect(canonicalUrlFor({ kind: 'channel', slug: 'sap-cap' }))
      .toBe('https://developers.sap.com/channels/sap-cap/');
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

// #1808 residual: the _shell page also leaks into two non-<head> spots the
// #1795 pass didn't cover — the BreadcrumbList JSON-LD (its own ld+json
// <script>, carrying the _shell page's own Home→_shell trail) and the visible
// embed-bar title span (`<span class=embed-bar__title>_shell</span>`, shown in
// embed=minimal mode). The shell below mirrors the live minified forms verified
// 2026-08-15: unquoted `type=application/ld+json`, unquoted class, and a SECOND
// (Organization) ld+json block that must survive the BreadcrumbList rewrite.
const CRUMB_SHELL_MIN =
  '<!DOCTYPE html><html lang=en data-page-kind=generic data-page-title=_shell>' +
  '<head><title>_shell</title>' +
  '<script type=application/ld+json>{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://developers.sap.com/"},{"@type":"ListItem","position":2,"name":"_shell","item":"https://developers.sap.com/_shell/"}]}</script>' +
  '<script type=application/ld+json>{"@context":"https://schema.org","@type":"Organization","name":"SAP","url":"https://developers.sap.com/"}</script>' +
  '</head><body>' +
  '<div class="embed-bar"><span class=embed-bar__title>_shell</span></div>' +
  '<header>chrome</header><!-- MAIN --><footer>foot</footer></body></html>';

describe('chrome-shell.composeShell — breadcrumb + embed-bar rewrite (#1808)', () => {
  const parsed = parseShell(CRUMB_SHELL_MIN);

  const bcJson = (html) => {
    const m = html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"BreadcrumbList".*?\})<\/script>/);
    return m ? JSON.parse(m[1]) : null;
  };

  it('rewrites the embed-bar title away from _shell', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'group', slug: 'group-x', title: 'Spatial Analytics', description: 'd',
    });
    expect(html).toContain('<span class="embed-bar__title">Spatial Analytics</span>');
    expect(html).not.toContain('embed-bar__title>_shell');
  });

  it('rebuilds the BreadcrumbList as Home → Tutorials → page for a group', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'group', slug: 'group-x', title: 'Spatial Analytics', description: 'd',
    });
    const bc = bcJson(html);
    expect(bc).not.toBeNull();
    expect(bc.itemListElement.map(e => e.name)).toEqual(['Home', 'Tutorials', 'Spatial Analytics']);
    expect(bc.itemListElement.map(e => e.position)).toEqual([1, 2, 3]);
    expect(bc.itemListElement[2].item).toBe('https://developers.sap.com/tutorials/group-x/');
    // No _shell crumb survives anywhere.
    expect(html).not.toContain('/_shell/');
    expect(html).not.toContain('"name":"_shell"');
  });

  it('rebuilds the BreadcrumbList as Home → Concepts → name for a concept', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'concept', slug: 'a2a-agent-protocol', title: 'A2A Protocol', description: 'd',
    });
    const bc = bcJson(html);
    expect(bc.itemListElement.map(e => e.name)).toEqual(['Home', 'Concepts', 'A2A Protocol']);
    expect(bc.itemListElement[1].item).toBe('https://developers.sap.com/concepts/');
    expect(bc.itemListElement[2].item).toBe('https://developers.sap.com/concepts/a2a-agent-protocol/');
  });

  it('builds a Home → Concepts trail for the concepts index (no trailing page crumb)', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'concepts-index', slug: 'concepts', title: 'Concepts', description: 'd',
    });
    const bc = bcJson(html);
    expect(bc.itemListElement.map(e => e.name)).toEqual(['Home', 'Concepts']);
    expect(bc.itemListElement[1].item).toBe('https://developers.sap.com/concepts/');
  });

  it('leaves the second (non-Breadcrumb) ld+json block untouched', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'group', slug: 'group-x', title: 'G', description: 'd',
    });
    expect(html).toContain('<script type=application/ld+json>{"@context":"https://schema.org","@type":"Organization","name":"SAP","url":"https://developers.sap.com/"}</script>');
  });

  it('escapes </script> and quotes in the title so JSON-LD cannot break out', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'group', slug: 'group-x', title: 'Evil </script><img> "x"', description: 'd',
    });
    // No raw </script> injected inside the rebuilt breadcrumb block.
    const bcBlock = html.match(/<script type="application\/ld\+json">.*?BreadcrumbList.*?<\/script>/)[0];
    expect(bcBlock).not.toContain('</script><img>');
    expect(bcBlock).toContain('\\u003c');
    // embed-bar text is HTML-escaped.
    expect(html).toContain('<span class="embed-bar__title">Evil &lt;/script&gt;&lt;img&gt; &quot;x&quot;</span>');
  });

  it('leaves an unknown kind\'s breadcrumb + embed-bar untouched', () => {
    const html = composeShell(parsed, '<main>B</main>', {
      kind: 'unknown', slug: 's', title: 'T', description: 'd',
    });
    // Unknown kind → no canonical trail we can trust, so the baked block stays.
    expect(html).toContain('"name":"_shell"');
  });
});

describe('chrome-shell.buildBreadcrumbJsonLd — puzzles (#1914 index)', () => {
  it('puzzle detail trail is Home → Puzzles → <title>', () => {
    const url = canonicalUrlFor({ kind: 'puzzle', slug: 'my-puzzle' });
    const json = buildBreadcrumbJsonLd({ kind: 'puzzle', slug: 'my-puzzle', title: 'My Puzzle' }, url);
    const bc = JSON.parse(json.replace(/\\u003c/g, '<'));
    const names = bc.itemListElement.map((e) => e.name);
    expect(names).toEqual(['Home', 'Puzzles', 'My Puzzle']);
    const puzzlesCrumb = bc.itemListElement.find((e) => e.name === 'Puzzles');
    expect(puzzlesCrumb.item).toBe('https://developers.sap.com/puzzles/');
  });

  it('puzzles-index trail is Home → Puzzles', () => {
    const json = buildBreadcrumbJsonLd({ kind: 'puzzles-index', slug: 'puzzles' }, 'https://developers.sap.com/puzzles/');
    const bc = JSON.parse(json.replace(/\\u003c/g, '<'));
    expect(bc.itemListElement.map((e) => e.name)).toEqual(['Home', 'Puzzles']);
  });

  it('channel detail trail is Home → Channels → <name> (channels-hub Phase 2)', () => {
    const url = canonicalUrlFor({ kind: 'channel', slug: 'sap-cap' });
    const json = buildBreadcrumbJsonLd({ kind: 'channel', slug: 'sap-cap', title: 'SAP CAP' }, url);
    const bc = JSON.parse(json.replace(/\\u003c/g, '<'));
    expect(bc.itemListElement.map((e) => e.name)).toEqual(['Home', 'Channels', 'SAP CAP']);
    const channelsCrumb = bc.itemListElement.find((e) => e.name === 'Channels');
    expect(channelsCrumb.item).toBe('https://developers.sap.com/channels/');
  });
});
