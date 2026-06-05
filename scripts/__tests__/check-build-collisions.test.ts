// scripts/__tests__/check-build-collisions.test.ts
//
// Unit tests for the Vite vs Hugo js.Build collision guard (#255).
//
// We don't fork a process to run the script's CLI entrypoint — instead we
// import the parsing helpers directly and assert against synthetic inputs.
// The integration-level "this script catches the production config" check
// is the live `postbuild:apps` invocation in CI; here we lock in the
// algorithm so a regex regression doesn't slip past.

import { describe, it, expect } from 'vitest';
import {
  parseViteEntries,
  parseLayoutJsBuilds,
  findCollisions,
  type ViteEntry,
  type HugoJsBuildRef,
} from '../check-build-collisions';

describe('parseViteEntries', () => {
  it('extracts quoted entry names', () => {
    const content = `
      input: {
        'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
        'tutorial-pip': resolve(__dirname, 'src/tutorial-pip/main.ts'),
      },
    `;
    const entries = parseViteEntries(content);
    expect(entries).toEqual([
      { name: 'tutorial-feedback', src: 'src/tutorial-feedback/main.ts' },
      { name: 'tutorial-pip',      src: 'src/tutorial-pip/main.ts' },
    ]);
  });

  it('extracts bare (unquoted) entry names', () => {
    const content = `
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        me:        resolve(__dirname, 'src/me/main.ts'),
      },
    `;
    const entries = parseViteEntries(content);
    expect(entries).toEqual([
      { name: 'navigator', src: 'src/navigator/main.ts' },
      { name: 'me',        src: 'src/me/main.ts' },
    ]);
  });

  it('extracts a mix of quoted + bare entries (matches real config style)', () => {
    const content = `
      navigator: resolve(__dirname, 'src/navigator/main.ts'),
      'app-space': resolve(__dirname, 'src/app-space/main.ts'),
      'tutorial-referred': resolve(__dirname, 'src/tutorial-referred/main.ts'),
    `;
    const entries = parseViteEntries(content);
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['app-space', 'navigator', 'tutorial-referred']);
  });

  it('returns empty for empty input', () => {
    expect(parseViteEntries('')).toEqual([]);
  });

  it('ignores non-input shape (false-positive guard)', () => {
    const content = `
      // Comments mentioning resolve(__dirname, 'foo') should not match
      const x = resolve(__dirname, 'foo'); // missing key: prefix
    `;
    expect(parseViteEntries(content)).toEqual([]);
  });
});

describe('parseLayoutJsBuilds', () => {
  it('extracts a single resources.Get | js.Build reference', () => {
    const content = [
      '<html>',
      '  <head>',
      '    {{ $js := resources.Get "js/tutorial.ts" | js.Build (dict "minify" true) }}',
      '    <script src="{{ $js.RelPermalink }}"></script>',
      '  </head>',
      '</html>',
    ].join('\n');
    const refs = parseLayoutJsBuilds('hugo/layouts/tutorials/single.html', content);
    expect(refs).toEqual([{
      src: 'js/tutorial.ts',
      name: 'tutorial',
      file: 'hugo/layouts/tutorials/single.html',
      line: 3,
    }]);
  });

  it('strips multi-segment leading paths (basename only for output)', () => {
    const content = `{{ $js := resources.Get "js/widgets/foo.ts" | js.Build }}`;
    const refs = parseLayoutJsBuilds('layout.html', content);
    expect(refs[0].name).toBe('foo');
    expect(refs[0].src).toBe('js/widgets/foo.ts');
  });

  it('handles single-quoted path syntax', () => {
    const content = `{{ $j := resources.Get 'js/ui5-bootstrap.ts' | js.Build }}`;
    const refs = parseLayoutJsBuilds('baseof.html', content);
    expect(refs[0].name).toBe('ui5-bootstrap');
  });

  it('returns multiple refs from one file at correct line numbers', () => {
    const content = [
      '{{ $a := resources.Get "js/a.ts" | js.Build }}',  // line 1
      '<!-- separator -->',                                // line 2
      '{{ $b := resources.Get "js/b.ts" | js.Build }}',  // line 3
    ].join('\n');
    const refs = parseLayoutJsBuilds('foo.html', content);
    expect(refs.map(r => ({ name: r.name, line: r.line }))).toEqual([
      { name: 'a', line: 1 },
      { name: 'b', line: 3 },
    ]);
  });

  it('returns empty for layouts with no js.Build', () => {
    const content = '<html><body>nothing here</body></html>';
    expect(parseLayoutJsBuilds('foo.html', content)).toEqual([]);
  });

  it('does not match resources.Get without js.Build (e.g. CSS pipelines)', () => {
    const content = `{{ $css := resources.Get "css/foo.css" | resources.PostCSS }}`;
    expect(parseLayoutJsBuilds('foo.html', content)).toEqual([]);
  });
});

describe('findCollisions', () => {
  const viteFixture = (names: string[]): ViteEntry[] =>
    names.map(name => ({ name, src: `src/${name}/main.ts` }));
  const hugoFixture = (names: string[]): HugoJsBuildRef[] =>
    names.map((name, i) => ({
      src: `js/${name}.ts`,
      name,
      file: `hugo/layouts/some/file-${i}.html`,
      line: i + 1,
    }));

  it('returns empty when names are disjoint', () => {
    const collisions = findCollisions(
      viteFixture(['navigator', 'browse', 'tutorial-referred']),
      hugoFixture(['tutorial', 'ui5-bootstrap'])
    );
    expect(collisions).toEqual([]);
  });

  it('flags a single collision', () => {
    const collisions = findCollisions(
      viteFixture(['navigator', 'tutorial']),
      hugoFixture(['tutorial', 'ui5-bootstrap'])
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('tutorial');
    expect(collisions[0].vite.src).toBe('src/tutorial/main.ts');
    expect(collisions[0].hugo.src).toBe('js/tutorial.ts');
  });

  it('flags multiple distinct collisions', () => {
    const collisions = findCollisions(
      viteFixture(['a', 'b', 'c']),
      hugoFixture(['b', 'c', 'd'])
    );
    expect(collisions.map(c => c.name).sort()).toEqual(['b', 'c']);
  });

  it('de-dups when one Hugo name appears in multiple layouts', () => {
    const refs: HugoJsBuildRef[] = [
      { src: 'js/tutorial.ts', name: 'tutorial', file: 'a.html', line: 1 },
      { src: 'js/tutorial.ts', name: 'tutorial', file: 'b.html', line: 2 },
    ];
    const collisions = findCollisions(viteFixture(['tutorial']), refs);
    expect(collisions).toHaveLength(1);
    // First-seen ref wins for the file:line attribution.
    expect(collisions[0].hugo.file).toBe('a.html');
  });
});

describe('integration: catches the original #251 collision against a synthetic config', () => {
  it('Vite tutorial + Hugo tutorial.ts → collision', () => {
    const viteSrc = `
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        tutorial:  resolve(__dirname, 'src/tutorial/main.ts'),
      },
    `;
    const layoutSrc = `{{ $js := resources.Get "js/tutorial.ts" | js.Build }}`;
    const viteEntries = parseViteEntries(viteSrc);
    const hugoRefs = parseLayoutJsBuilds('layout.html', layoutSrc);
    const collisions = findCollisions(viteEntries, hugoRefs);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].name).toBe('tutorial');
  });

  it('after the #251 rename (tutorial-referred) → no collision', () => {
    const viteSrc = `
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        'tutorial-referred': resolve(__dirname, 'src/tutorial-referred/main.ts'),
      },
    `;
    const layoutSrc = `{{ $js := resources.Get "js/tutorial.ts" | js.Build }}`;
    const viteEntries = parseViteEntries(viteSrc);
    const hugoRefs = parseLayoutJsBuilds('layout.html', layoutSrc);
    expect(findCollisions(viteEntries, hugoRefs)).toEqual([]);
  });
});
