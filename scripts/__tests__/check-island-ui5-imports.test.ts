// scripts/__tests__/check-island-ui5-imports.test.ts
//
// Unit tests for the Vue-island direct-UI5-import guard. Mirrors the style
// of check-build-collisions.test.ts — import the parser helpers and assert
// against synthetic inputs. The integration-level "live config has no
// findings" check happens via `postbuild:apps` on every CI build.

import { describe, it, expect } from 'vitest';
import { extractImports, parseViteEntries, isSharedUi5Entry } from '../check-island-ui5-imports';

describe('extractImports', () => {
  it('finds bare-specifier side-effect imports', () => {
    const src = [
      "import \"@ui5/webcomponents/dist/Title.js\";",
      "import 'some-other-pkg';",
    ].join('\n');
    expect(extractImports(src)).toEqual([
      { spec: '@ui5/webcomponents/dist/Title.js', line: 1 },
      { spec: 'some-other-pkg', line: 2 },
    ]);
  });

  it('finds named + default imports', () => {
    const src = [
      "import { createApp } from 'vue';",
      "import MyCompletions from './MyCompletions.vue';",
    ].join('\n');
    expect(extractImports(src)).toEqual([
      { spec: 'vue', line: 1 },
      { spec: './MyCompletions.vue', line: 2 },
    ]);
  });

  it('finds re-exports', () => {
    const src = "export * from './prefs-store';";
    expect(extractImports(src)).toEqual([
      { spec: './prefs-store', line: 1 },
    ]);
  });

  it('ignores import-like comments', () => {
    const src = [
      "// import '@ui5/webcomponents/dist/Title.js';",
      "/* import 'fake-pkg'; */",
      "const fake = `import 'still-fake';`;",
    ].join('\n');
    // The regex requires a leading `import|export` keyword at start of a
    // trimmed line — these all fail. Comments are line-prefixed by `// ` etc.
    expect(extractImports(src)).toEqual([]);
  });

  it('handles import statements after leading whitespace', () => {
    const src = "    import 'whitespace-leader';";
    expect(extractImports(src)).toEqual([
      { spec: 'whitespace-leader', line: 1 },
    ]);
  });
});

describe('parseViteEntries (shared with check-build-collisions)', () => {
  it('extracts entries from a config-shaped string', () => {
    const content = `
      me: resolve(__dirname, 'src/me/main.ts'),
      'tutorial-feedback': resolve(__dirname, 'src/tutorial-feedback/main.ts'),
    `;
    expect(parseViteEntries(content)).toEqual([
      { name: 'me', src: 'src/me/main.ts' },
      { name: 'tutorial-feedback', src: 'src/tutorial-feedback/main.ts' },
    ]);
  });
});

describe('isSharedUi5Entry (code-split exemption #1777/#1797)', () => {
  it('exempts the dedicated shared-UI5 entries under src/ui5/', () => {
    for (const src of [
      'src/ui5/ui5-core.ts',
      'src/ui5/ui5-tutorial.ts',
      'src/ui5/ui5-me.ts',
      'src/ui5/ui5-illustrations.ts',
    ]) {
      expect(isSharedUi5Entry({ name: 'ui5-x', src })).toBe(true);
    }
  });

  it('still scans real island entries (src/<island>/main.ts)', () => {
    for (const src of [
      'src/me/main.ts',
      'src/navigator/main.ts',
      'src/tutorial-feedback/main.ts',
    ]) {
      expect(isSharedUi5Entry({ name: 'island', src })).toBe(false);
    }
  });

  it('normalizes Windows backslash paths before matching', () => {
    expect(isSharedUi5Entry({ name: 'ui5-core', src: 'src\\ui5\\ui5-core.ts' })).toBe(true);
  });
});
