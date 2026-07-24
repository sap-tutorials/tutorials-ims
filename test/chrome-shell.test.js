import { describe, it, expect } from 'vitest';
import { parseShell, composeShell, ShellMarkerError } from '../srv/lib/chrome-shell.js';

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
