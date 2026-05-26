# VitePress Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a VitePress 1.6.x documentation site for the existing reorganized `docs/` tree, with custom Horizon (Fiori Fundamentals) theming via CSS-only bridge, self-hosted SAP "72" font, manual sidebar config, local search, deployed to GitHub Pages via Actions workflow.

**Architecture:** Pure static site, separate from CAP / Hugo / approuter. VitePress source at `docs/`, theme overrides at `docs/.vitepress/theme/`, build output at `docs/.vitepress/dist/`. Custom theme extends `DefaultTheme` and bridges Horizon design tokens via `:root` and `:root.dark` CSS variable overrides — no Vue component overrides. SAP "72" `.woff2` files are copied from `@sap-theming/theming-base-content` into `docs/.vitepress/public/fonts/` by a `predocs:*` script. Build is gated by a sidebar-completeness check that compares on-disk `docs/<persona>/**/*.md` against the manual sidebar config. Three-phase rollout: phase 1 lands the PR with the workflow's `on.push` block commented out.

**Tech Stack:** VitePress 1.6.x (pinned, Vue 3 ships transitively), `@sap-theming/theming-base-content` (publicly published npm package, source of SAP "72" .woff2), Vitest (already in devDeps — used for the two helper scripts' tests), GitHub Actions Pages workflow (`actions/configure-pages@v5`, `upload-pages-artifact@v3`, `deploy-pages@v4`).

**Spec:** [docs/superpowers/specs/2026-05-25-vitepress-docs-site-design.md](../specs/2026-05-25-vitepress-docs-site-design.md)

---

## Working conventions for every task in this plan

- **Worktree.** All work happens in `.worktrees/vitepress-docs-site/` on branch `docs/vitepress-site`. Never run these tasks from the main checkout — see [memory:feedback_parallel_agents_worktrees].
- **Windows path discipline.** Use forward slashes in shell paths. After multi-section edits, verify line endings with `file <path>` — see [memory:feedback_crlf_regression_on_windows].
- **VitePress version pin.** Always `npm install vitepress@~1.6.0`, never `vitepress` bare or `@latest`. The 2.x line is still alpha; the spec deferred it.
- **`tsx` is already a devDependency.** `scripts/check-docs-sidebar.cjs` does `require('tsx/cjs')` to load `config.ts`. Verified before writing this plan: `package.json` already has `"tsx": "^4.0.0"` in devDependencies — do not re-add it.
- **No bulk dead-link autofix.** When the link sweep finds a hit, decide per match whether to rewrite or remove. Editorial intent matters more than passing the dead-link check.
- **One commit per task.** Tasks land in order; the tree is clean between tasks. Commit messages follow `docs(vitepress): ...` for content/config changes and `feat(docs): ...` for the workflow.
- **TDD where the task has logic.** Tasks 2 (font copy) and 3 (sidebar check) are real scripts with branching logic — write the failing test first, watch it fail, implement, watch it pass, commit. The other tasks are config/scaffolding; their "test" is `npm run docs:build` succeeding.
- **`docs:build` is the integration gate.** Every task that touches build inputs (config, theme, sidebar, content) ends with a `npm run docs:build` smoke run before the commit.
- **Don't deploy yet.** The GitHub Actions workflow lands with its `on.push` block commented out (Task 12). Phase-2 deploy enablement is Tom's manual step after PR review.

---

## File structure

```
docs/
├── README.md                                     MODIFY (replace persona-index body with home layout frontmatter)
├── improvements.md                               UNTOUCHED (excluded via srcExclude)
├── TODO.md                                       UNTOUCHED (excluded)
├── pilot-status.md                               UNTOUCHED (excluded)
├── superpowers/                                  UNTOUCHED (excluded via srcExclude `superpowers/**`)
├── end-users/                                    UNTOUCHED (6 pages — public)
├── authors/
│   ├── README.md                                 MODIFY (append sidebar maintenance note)
│   ├── ...                                       UNTOUCHED
├── developers/                                   UNTOUCHED (23 pages — public)
├── historic/                                     UNTOUCHED (10 pages — public, including vitepress-2x-upgrade-assessment.md)
└── .vitepress/                                   NEW
    ├── config.ts                                 NEW (defineConfig, top-level srcExclude, manual sidebar, head preloads, etc.)
    ├── theme/
    │   ├── index.ts                              NEW (extends DefaultTheme, imports CSS)
    │   └── styles/
    │       ├── fonts.css                         NEW (@font-face for "72" variants)
    │       └── horizon-bridge.css                NEW (--vp-c-* token overrides under :root and :root.dark)
    └── public/
        ├── favicon.svg                           NEW
        ├── logo-light.svg                        NEW
        ├── logo-dark.svg                         NEW
        └── fonts/                                GIT-IGNORED (populated by scripts/copy-sap-fonts.cjs at build time)

scripts/
├── copy-sap-fonts.cjs                            NEW (predocs:dev / predocs:build — copies "72" woff2 from node_modules)
└── check-docs-sidebar.cjs                        NEW (predocs:build — fails if sidebar config and on-disk pages disagree)

test/
└── unit/
    └── docs-tooling/                             NEW directory
        ├── copy-sap-fonts.test.js                NEW
        └── check-docs-sidebar.test.js            NEW

.github/workflows/
└── docs-deploy.yml                               NEW (build → upload-pages-artifact → deploy-pages; on.push commented out for phase 1)

.gitignore                                        MODIFY (add docs/.vitepress/{dist,cache,public/fonts}/)
package.json                                      MODIFY (add devDeps + 4 scripts)
package-lock.json                                 MODIFY (refreshed by npm install)
CLAUDE.md                                         MODIFY (Documentation section — add docs site URL + commands)
```

---

## Task 1: Add dependencies and npm scripts

**Why first:** Subsequent tasks reference `vitepress` and the SAP theming package — they need to resolve.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto-refreshed)

- [ ] **Step 1: Verify the worktree state**

```bash
pwd                          # expect: .../.worktrees/vitepress-docs-site
git branch --show-current    # expect: docs/vitepress-site
git status --short           # expect: clean
```

- [ ] **Step 2: Add devDependencies**

Edit `package.json` `devDependencies` to add (preserve alphabetical order with the surrounding entries):

```json
"@sap-theming/theming-base-content": "^11.0.0",
...
"vitepress": "~1.6.0",
```

(Use `~1.6.0` to allow patch updates inside 1.6.x but block the 2.x line.)

- [ ] **Step 3: Add npm scripts**

Edit `package.json` `scripts` and add four entries (place them after the existing `docs:*` entries if any, otherwise at the end of the block):

```json
"predocs:dev": "node scripts/copy-sap-fonts.cjs",
"docs:dev": "vitepress dev docs",
"predocs:build": "node scripts/copy-sap-fonts.cjs && node scripts/check-docs-sidebar.cjs",
"docs:build": "vitepress build docs",
"docs:preview": "vitepress preview docs"
```

- [ ] **Step 4: Install**

Run: `npm install`

Expected: `package-lock.json` refreshes; both new packages appear in `node_modules/`. No peer-dependency errors.

Verify both packages resolve:

```bash
node -e "console.log(require.resolve('vitepress/package.json'))"
node -e "console.log(require.resolve('@sap-theming/theming-base-content/package.json'))"
```

Both should print absolute paths.

- [ ] **Step 5: Verify VitePress version pin**

```bash
npm ls vitepress
```

Expected: `vitepress@1.6.x` (where x ≥ 4). If it resolves to 2.x, the constraint failed — re-check `package.json`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "docs(vitepress): add vitepress + sap theming dependencies and scripts"
```

---

## Task 2: Font copy script (TDD)

**Why second:** `predocs:dev` and `predocs:build` reference this script; running `docs:dev` in any later task without it errors. TDD makes sense — the script has find/copy/skip-when-current branches.

**Files:**
- Create: `scripts/copy-sap-fonts.cjs`
- Create: `test/unit/docs-tooling/copy-sap-fonts.test.js`

- [ ] **Step 1: Locate the fonts in the installed package**

Discover the actual subpath inside `@sap-theming/theming-base-content` (the spec didn't pin one). Run:

```bash
node -e "const p = require.resolve('@sap-theming/theming-base-content/package.json'); console.log(require('path').dirname(p));" \
  | xargs -I{} fd '72-Regular\.woff2$' {}
```

Expected: 1+ paths printed. Note the `Fonts/72/` (or similar) common prefix — the script will glob for `72-*.woff2` under it. If zero paths are found, the package layout changed — escalate to Tom rather than guessing.

- [ ] **Step 2: Write the failing test**

Create `test/unit/docs-tooling/copy-sap-fonts.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this test file's location so vitest cwd doesn't matter.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'copy-sap-fonts.cjs');

function run(targetDir) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, COPY_SAP_FONTS_TARGET: targetDir },
    encoding: 'utf8'
  });
}

describe('scripts/copy-sap-fonts.cjs', () => {
  let target;
  beforeEach(() => { target = mkdtempSync(join(tmpdir(), 'sap-fonts-')); });
  afterEach(() => { rmSync(target, { recursive: true, force: true }); });

  it('copies the five 72 variants into the target directory', () => {
    run(target);
    for (const name of ['72-Regular', '72-Bold', '72-Italic', '72-Light', '72-BoldItalic']) {
      expect(existsSync(join(target, `${name}.woff2`)), `${name}.woff2 should exist`).toBe(true);
      expect(statSync(join(target, `${name}.woff2`)).size).toBeGreaterThan(1024);
    }
  });

  it('is idempotent: a second run leaves files unchanged', () => {
    run(target);
    const first = statSync(join(target, '72-Regular.woff2')).mtimeMs;
    // Force a measurable mtime gap on Windows (FAT-style 2s resolution is uncommon on NTFS but be safe)
    const wait = Date.now() + 50; while (Date.now() < wait);
    run(target);
    const second = statSync(join(target, '72-Regular.woff2')).mtimeMs;
    expect(second).toBe(first); // skip-when-current branch hit
  });

  it('exits non-zero with a clear message if the SAP package is missing', () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), 'sap-fonts-fake-'));
    mkdirSync(join(fakeRoot, 'node_modules'), { recursive: true });
    try {
      execFileSync(process.execPath, [SCRIPT], {
        env: { ...process.env, COPY_SAP_FONTS_TARGET: target, COPY_SAP_FONTS_NODE_MODULES: join(fakeRoot, 'node_modules') },
        encoding: 'utf8'
      });
      throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stderr || err.message)).toMatch(/@sap-theming\/theming-base-content/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/unit/docs-tooling/copy-sap-fonts.test.js
```

Expected: 3 failures, all about the script not existing.

- [ ] **Step 4: Implement the script**

Create `scripts/copy-sap-fonts.cjs`:

```js
#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VARIANTS = ['72-Regular', '72-Bold', '72-Italic', '72-Light', '72-BoldItalic'];

const targetDir = process.env.COPY_SAP_FONTS_TARGET
  || path.resolve(__dirname, '..', 'docs', '.vitepress', 'public', 'fonts');

const nodeModulesDir = process.env.COPY_SAP_FONTS_NODE_MODULES
  || path.resolve(__dirname, '..', 'node_modules');

function findPackageRoot() {
  const pkg = path.join(nodeModulesDir, '@sap-theming', 'theming-base-content', 'package.json');
  if (!fs.existsSync(pkg)) {
    console.error(
      `@sap-theming/theming-base-content not found at ${pkg}. ` +
      `Run \`npm install\` and re-run this script.`
    );
    process.exit(1);
  }
  return path.dirname(pkg);
}

function findVariant(packageRoot, variant) {
  // Walk the package looking for "<variant>.woff2". Stops at first match.
  const want = `${variant}.woff2`;
  const stack = [packageRoot];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === want) return full;
    }
  }
  return null;
}

function copyIfChanged(src, dst) {
  if (fs.existsSync(dst)) {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return false;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function main() {
  const packageRoot = findPackageRoot();
  fs.mkdirSync(targetDir, { recursive: true });

  const missing = [];
  let copied = 0;
  for (const v of VARIANTS) {
    const src = findVariant(packageRoot, v);
    if (!src) { missing.push(v); continue; }
    if (copyIfChanged(src, path.join(targetDir, `${v}.woff2`))) copied++;
  }

  if (missing.length) {
    console.error(`Could not locate ${missing.length} variant(s) in @sap-theming/theming-base-content: ${missing.join(', ')}.`);
    console.error('Package layout may have changed — inspect node_modules/@sap-theming/theming-base-content/ and update scripts/copy-sap-fonts.cjs.');
    process.exit(1);
  }

  console.log(`copy-sap-fonts: ${copied} new/updated, ${VARIANTS.length - copied} up-to-date → ${targetDir}`);
}

main();
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/unit/docs-tooling/copy-sap-fonts.test.js
```

Expected: 3 passing.

- [ ] **Step 6: Smoke run against the real target**

```bash
node scripts/copy-sap-fonts.cjs
ls docs/.vitepress/public/fonts/
```

Expected: 5 `.woff2` files, all > 1KB.

- [ ] **Step 7: Commit**

```bash
git add scripts/copy-sap-fonts.cjs test/unit/docs-tooling/copy-sap-fonts.test.js
git commit -m "docs(vitepress): add copy-sap-fonts.cjs script with vitest coverage"
```

---

## Task 3: Sidebar-completeness check script (TDD)

**Why third:** `predocs:build` runs this script. The VitePress build in Task 4 must not be the first thing that exercises it.

**Files:**
- Create: `scripts/check-docs-sidebar.cjs`
- Create: `test/unit/docs-tooling/check-docs-sidebar.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/docs-tooling/check-docs-sidebar.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'check-docs-sidebar.cjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-check-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, '.vitepress'), { recursive: true });
  mkdirSync(join(docs, 'end-users'), { recursive: true });
  mkdirSync(join(docs, 'authors'), { recursive: true });
  return { root, docs };
}

function writePage(docs, rel) {
  const full = join(docs, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `# ${rel}\n`);
}

function writeConfig(docs, sidebar) {
  // Minimal config-like CommonJS module the script can require.
  const body = `module.exports = ${JSON.stringify({ themeConfig: { sidebar } }, null, 2)};\n`;
  writeFileSync(join(docs, '.vitepress', 'config.cjs'), body);
}

function run(root) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHECK_DOCS_SIDEBAR_ROOT: root },
    encoding: 'utf8'
  });
}

describe('scripts/check-docs-sidebar.cjs', () => {
  let root, docs;
  beforeEach(() => { ({ root, docs } = fixture()); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every persona page is registered and every link resolves', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'end-users/getting-started.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [
        { text: 'Overview', link: '/end-users/' },
        { text: 'Getting started', link: '/end-users/getting-started' }
      ]}]
    });
    const out = run(root);
    expect(out).toMatch(/ok/i);
  });

  it('fails listing unregistered pages', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'end-users/orphan.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [{ text: 'Overview', link: '/end-users/' }] }]
    });
    try {
      run(root); throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stdout || err.stderr || '')).toMatch(/end-users\/orphan/);
    }
  });

  it('fails listing dead sidebar links', () => {
    writePage(docs, 'end-users/README.md');
    writeConfig(docs, {
      '/end-users/': [{ items: [
        { text: 'Overview', link: '/end-users/' },
        { text: 'Missing', link: '/end-users/missing' }
      ]}]
    });
    try {
      run(root); throw new Error('expected non-zero exit');
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(String(err.stdout || err.stderr || '')).toMatch(/end-users\/missing/);
    }
  });

  it('honors srcExclude — excluded pages do not need to be in the sidebar', () => {
    writePage(docs, 'end-users/README.md');
    writePage(docs, 'superpowers/secret.md');
    const cfg = { themeConfig: { sidebar: { '/end-users/': [{ items: [{ text: 'Overview', link: '/end-users/' }]}] } }, srcExclude: ['superpowers/**'] };
    writeFileSync(join(docs, '.vitepress', 'config.cjs'), `module.exports = ${JSON.stringify(cfg)};\n`);
    const out = run(root);
    expect(out).toMatch(/ok/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/docs-tooling/check-docs-sidebar.test.js
```

Expected: 4 failures (script doesn't exist).

- [ ] **Step 3: Implement the script**

Create `scripts/check-docs-sidebar.cjs`:

```js
#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.env.CHECK_DOCS_SIDEBAR_ROOT
  || path.resolve(__dirname, '..');
const docsRoot = path.join(repoRoot, 'docs');

const PERSONAS = ['end-users', 'authors', 'developers', 'historic'];

function loadConfig() {
  // Tests inject a .cjs sibling. Production reads .vitepress/config.ts via a require
  // hook would be heavier than needed — instead, prefer config.cjs if present, else
  // import config.ts via the TypeScript-aware path used by VitePress itself.
  const cjs = path.join(docsRoot, '.vitepress', 'config.cjs');
  if (fs.existsSync(cjs)) return require(cjs);
  const ts = path.join(docsRoot, '.vitepress', 'config.ts');
  if (!fs.existsSync(ts)) {
    console.error(`No config found at ${cjs} or ${ts}`);
    process.exit(1);
  }
  // Use VitePress's own TS compilation path. tsx is a dev dep already.
  require('tsx/cjs');
  const mod = require(ts);
  return mod.default || mod;
}

function globMatch(rel, pattern) {
  // Tiny glob: handles literal segments and `**` only (the only pattern srcExclude uses here).
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'
  );
  return re.test(rel);
}

function isExcluded(rel, srcExclude) {
  return (srcExclude || []).some(p => globMatch(rel, p));
}

function walkPersonaPages(srcExclude) {
  const found = [];
  for (const persona of PERSONAS) {
    const dir = path.join(docsRoot, persona);
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        const rel = path.relative(docsRoot, full).split(path.sep).join('/');
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md') && !isExcluded(rel, srcExclude)) {
          found.push(rel);
        }
      }
    }
  }
  return found;
}

function pageToLink(rel) {
  // docs/end-users/README.md -> /end-users/
  // docs/end-users/getting-started.md -> /end-users/getting-started
  let link = '/' + rel.replace(/\.md$/, '');
  if (link.endsWith('/README')) link = link.slice(0, -'README'.length);
  return link;
}

function linkToPage(link) {
  // /end-users/ -> end-users/README.md
  // /end-users/getting-started -> end-users/getting-started.md
  let rel = link.replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) rel += 'README';
  return rel + '.md';
}

function flattenSidebar(sidebarConfig) {
  const links = [];
  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (node.link) links.push(node.link);
    if (node.items) visit(node.items);
    // VitePress sidebar can be keyed-by-prefix object — recurse only into nested objects/arrays.
    for (const k of Object.keys(node)) {
      if (k === 'link' || k === 'items' || k === 'text' || k === 'collapsed') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v);
    }
  }
  visit(sidebarConfig);
  return links;
}

function main() {
  const cfg = loadConfig();
  const sidebar = cfg.themeConfig && cfg.themeConfig.sidebar;
  if (!sidebar) {
    console.error('No themeConfig.sidebar in VitePress config');
    process.exit(1);
  }

  const srcExclude = cfg.srcExclude || [];
  const onDisk = walkPersonaPages(srcExclude);
  const sidebarLinks = flattenSidebar(sidebar)
    .filter(l => typeof l === 'string' && l.startsWith('/') && !/^https?:/.test(l));

  const onDiskLinks = new Set(onDisk.map(pageToLink));
  const sidebarSet = new Set(sidebarLinks);

  const unregistered = [...onDiskLinks].filter(l => !sidebarSet.has(l));
  const dead = sidebarLinks.filter(l => {
    const rel = linkToPage(l);
    return !fs.existsSync(path.join(docsRoot, rel));
  });

  let bad = false;
  if (unregistered.length) {
    bad = true;
    console.error('Unregistered pages (on disk but not in sidebar):');
    unregistered.sort().forEach(l => console.error('  ' + l));
  }
  if (dead.length) {
    bad = true;
    console.error('Dead sidebar links (in sidebar but not on disk):');
    dead.sort().forEach(l => console.error('  ' + l));
  }
  if (bad) process.exit(1);

  console.log(`check-docs-sidebar: ok (${onDisk.length} pages, ${sidebarLinks.length} links)`);
}

main();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/docs-tooling/check-docs-sidebar.test.js
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-docs-sidebar.cjs test/unit/docs-tooling/check-docs-sidebar.test.js
git commit -m "docs(vitepress): add check-docs-sidebar.cjs guard script with vitest coverage"
```

---

## Task 4: VitePress scaffold (config + theme + minimal sidebar)

**Why fourth:** This is the first task whose smoke test is `npm run docs:dev` — needs Tasks 2 and 3 in place.

**Files:**
- Create: `docs/.vitepress/config.ts`
- Create: `docs/.vitepress/theme/index.ts`
- Create: `docs/.vitepress/theme/styles/horizon-bridge.css`
- Create: `docs/.vitepress/theme/styles/fonts.css`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.gitignore` entries**

Append to `.gitignore`:

```
# VitePress documentation site
docs/.vitepress/dist/
docs/.vitepress/cache/
docs/.vitepress/public/fonts/
```

- [ ] **Step 2: Create `docs/.vitepress/theme/styles/fonts.css`**

```css
@font-face { font-family: '72'; src: url('/fonts/72-Regular.woff2')   format('woff2'); font-weight: 400; font-style: normal;  font-display: swap; }
@font-face { font-family: '72'; src: url('/fonts/72-Bold.woff2')      format('woff2'); font-weight: 700; font-style: normal;  font-display: swap; }
@font-face { font-family: '72'; src: url('/fonts/72-Italic.woff2')    format('woff2'); font-weight: 400; font-style: italic;  font-display: swap; }
@font-face { font-family: '72'; src: url('/fonts/72-Light.woff2')     format('woff2'); font-weight: 300; font-style: normal;  font-display: swap; }
@font-face { font-family: '72'; src: url('/fonts/72-BoldItalic.woff2') format('woff2'); font-weight: 700; font-style: italic;  font-display: swap; }
```

(VitePress prepends the site `base` to root-relative URLs in CSS automatically.)

- [ ] **Step 3: Create `docs/.vitepress/theme/styles/horizon-bridge.css`**

```css
:root {
  --vp-c-brand-1: #0070f2;
  --vp-c-brand-2: #0056cf;
  --vp-c-brand-3: #003f9c;
  --vp-c-brand-soft: rgba(0, 112, 242, 0.14);

  --vp-c-bg: #ffffff;
  --vp-c-bg-alt: #f5f6f7;
  --vp-c-bg-elv: #ffffff;

  --vp-c-text-1: #1d2d3e;
  --vp-c-text-2: #475e75;
  --vp-c-text-3: #6a7d92;

  --vp-c-divider: #e4e7ea;
  --vp-c-border: #cbd5dc;

  --vp-code-bg: #f5f6f7;
  --vp-code-block-bg: #f5f6f7;

  --vp-font-family-base: '72', '72full', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

:root.dark {
  --vp-c-brand-1: #1b90ff;
  --vp-c-brand-2: #4dabff;
  --vp-c-brand-3: #79c0ff;
  --vp-c-brand-soft: rgba(27, 144, 255, 0.18);

  --vp-c-bg: #1c2228;
  --vp-c-bg-alt: #232a31;
  --vp-c-bg-elv: #2a323a;

  --vp-c-text-1: #eaecee;
  --vp-c-text-2: #b3bcc5;
  --vp-c-text-3: #8a96a3;

  --vp-c-divider: #2a323a;
  --vp-c-border: #3a4651;

  --vp-code-bg: #232a31;
  --vp-code-block-bg: #232a31;
}
```

- [ ] **Step 4: Create `docs/.vitepress/theme/index.ts`**

```ts
import DefaultTheme from 'vitepress/theme';
import './styles/fonts.css';
import './styles/horizon-bridge.css';

export default DefaultTheme;
```

- [ ] **Step 5: Create `docs/.vitepress/config.ts`**

Minimal first cut — sidebar starts as one stub block per persona, fleshed out in Task 8.

```ts
import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'SAP Tutorials Platform',
  description: 'The platform behind developers.sap.com — for readers, authors, and engineers.',
  base: '/tutorials-poc/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'auto',

  srcExclude: ['improvements.md', 'TODO.md', 'pilot-status.md', 'superpowers/**'],

  head: [
    ['link', { rel: 'icon', href: '/tutorials-poc/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preload', href: '/tutorials-poc/fonts/72-Regular.woff2', as: 'font', type: 'font/woff2', crossorigin: '' }],
    ['link', { rel: 'preload', href: '/tutorials-poc/fonts/72-Bold.woff2',    as: 'font', type: 'font/woff2', crossorigin: '' }]
  ],

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' }
  },

  themeConfig: {
    nav: [
      { text: 'End Users',  link: '/end-users/' },
      { text: 'Authors',    link: '/authors/' },
      { text: 'Developers', link: '/developers/' },
      { text: 'Historic',   link: '/historic/' }
    ],

    sidebar: {
      '/end-users/':  [{ text: 'End Users',  items: [{ text: 'Overview', link: '/end-users/' }] }],
      '/authors/':    [{ text: 'Authors',    items: [{ text: 'Overview', link: '/authors/' }] }],
      '/developers/': [{ text: 'Developers', items: [{ text: 'Overview', link: '/developers/' }] }],
      '/historic/':   [{ text: 'Historic',   items: [{ text: 'Overview', link: '/historic/' }] }]
    },

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/sap-tutorials/tutorials-poc/edit/main/docs/:path',
      text: 'Suggest an edit on GitHub'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sap-tutorials/tutorials-poc' }
    ]
  }
});
```

- [ ] **Step 6: Smoke run `docs:dev`**

```bash
npm run docs:dev
```

Expected: server starts and prints a banner like `➜  Local:   http://localhost:5173/tutorials-poc/` (port 5173 is VitePress default; if another Vite server is running it will pick the next free port — read the actual URL from the banner). Open it in a browser, confirm:
- The four persona landing pages are reachable from the top nav.
- Light/dark toggle cycles theme; brand color changes between `#0070f2` and `#1b90ff`.
- DevTools → Network shows `72-Regular.woff2` and `72-Bold.woff2` loading from `/tutorials-poc/fonts/`.

Stop the server (Ctrl+C). Note: pages will currently 404 at deeper URLs because the sidebar doesn't list them yet. That's expected — Task 8 fills it in.

- [ ] **Step 7: Commit**

```bash
git add .gitignore docs/.vitepress/config.ts docs/.vitepress/theme/index.ts docs/.vitepress/theme/styles/fonts.css docs/.vitepress/theme/styles/horizon-bridge.css
git commit -m "docs(vitepress): scaffold config, default theme extension, and Horizon CSS bridge"
```

---

## Task 5: Public assets (favicon, logos)

**Files:**
- Create: `docs/.vitepress/public/favicon.svg`
- Create: `docs/.vitepress/public/logo-light.svg`
- Create: `docs/.vitepress/public/logo-dark.svg`

- [ ] **Step 1: Source the SAP wordmark + favicon**

Use minimal hand-rolled SVGs — no external dependency, no licensing question. The favicon is a rounded square with "SAP" text in Horizon brand color; light/dark logos are the same wordmark with appropriate fill.

Create `docs/.vitepress/public/favicon.svg`:

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="SAP Tutorials">
  <rect width="64" height="64" rx="12" fill="#0070f2"/>
  <text x="32" y="40" font-family="72,Helvetica,Arial,sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#ffffff">SAP</text>
</svg>
```

Create `docs/.vitepress/public/logo-light.svg`:

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 64" role="img" aria-label="SAP Tutorials Platform">
  <text x="0" y="44" font-family="72,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#0070f2">SAP</text>
  <text x="76" y="44" font-family="72,Helvetica,Arial,sans-serif" font-size="34" font-weight="400" fill="#1d2d3e">Tutorials Platform</text>
</svg>
```

Create `docs/.vitepress/public/logo-dark.svg`:

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 64" role="img" aria-label="SAP Tutorials Platform">
  <text x="0" y="44" font-family="72,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#1b90ff">SAP</text>
  <text x="76" y="44" font-family="72,Helvetica,Arial,sans-serif" font-size="34" font-weight="400" fill="#eaecee">Tutorials Platform</text>
</svg>
```

- [ ] **Step 2: Verify in browser**

```bash
npm run docs:dev
```

Open the URL from the dev-server banner (default `http://localhost:5173/tutorials-poc/`). Tab favicon should be the SAP rounded square. (Hero logo isn't visible yet — Task 7 wires it via the home layout.)

Stop the server.

- [ ] **Step 3: Commit**

```bash
git add docs/.vitepress/public/favicon.svg docs/.vitepress/public/logo-light.svg docs/.vitepress/public/logo-dark.svg
git commit -m "docs(vitepress): add favicon and SAP wordmark logos for hero"
```

---

## Task 6: Link sweep and dead-link fixes

**Why before flipping `docs/README.md` to home layout:** The dead-link sweep is easier to read against the current persona-index version of the file.

**Files:**
- Modify: any `docs/**/*.md` file flagged by the sweep.

- [ ] **Step 1: Run the sweep**

```bash
rg -n '\]\((\.\./){2,}(README|CLAUDE)\.md|\]\((\.\./)*(improvements|TODO|pilot-status)\.md|\]\((\.\./)*superpowers/' docs/
```

Save hits to a scratch file:

```bash
rg -n '\]\((\.\./){2,}(README|CLAUDE)\.md|\]\((\.\./)*(improvements|TODO|pilot-status)\.md|\]\((\.\./)*superpowers/' docs/ > /tmp/dead-link-sweep.txt
wc -l /tmp/dead-link-sweep.txt
```

- [ ] **Step 2: Categorize and rewrite**

Open `/tmp/dead-link-sweep.txt` and decide per match:

| Target | Decision |
|---|---|
| `improvements.md`, `TODO.md`, `pilot-status.md` | Remove the link or replace with editorial prose. These files are excluded from the public site by `srcExclude`. |
| `superpowers/**` | Remove the link (planning artifacts are not public). |
| `../../README.md` (or deeper `../../../README.md`) | Rewrite to absolute GitHub URL: `https://github.com/sap-tutorials/tutorials-poc/blob/main/README.md`. Note: a single-level `../README.md` from a persona child page resolves to `docs/README.md` (the home page) and is a valid in-site link — the regex deliberately requires 2+ `../` to skip those. |
| `../../CLAUDE.md` (or deeper) | Rewrite to absolute GitHub URL: `https://github.com/sap-tutorials/tutorials-poc/blob/main/CLAUDE.md`. Same single-level caveat as README. |

Edit each flagged file with `Edit` (one Edit call per change to keep the diff readable).

- [ ] **Step 3: Re-run the sweep**

```bash
rg -n '\]\((\.\./){2,}(README|CLAUDE)\.md|\]\((\.\./)*(improvements|TODO|pilot-status)\.md|\]\((\.\./)*superpowers/' docs/
```

Expected: zero matches.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(vitepress): rewrite cross-links to excluded files and project root"
```

---

## Task 7: Transform `docs/README.md` to home layout

**Files:**
- Modify: `docs/README.md`

- [ ] **Step 1: Read the current file**

```bash
wc -l docs/README.md
```

Note the current persona-index body — it's about to be replaced.

- [ ] **Step 2: Replace the body**

Use `Write` (a full overwrite is cleanest here — the current persona-index is ~50-line plain text and the new file is structurally different):

```markdown
---
layout: home
hero:
  name: SAP Tutorials Platform
  tagline: The platform behind developers.sap.com — for readers, authors, and engineers.
  image:
    src: /logo-light.svg
    alt: SAP Tutorials
  actions:
    - theme: brand
      text: Read the user guide
      link: /end-users/
    - theme: alt
      text: Author a tutorial
      link: /authors/
features:
  - title: For Readers
    details: How developers.sap.com works, signing in, progress, privacy, and accessibility.
    link: /end-users/
    linkText: Read the user guide
  - title: For Authors
    details: Writing tutorials, validating with the QA preview channel, and getting them into developers.sap.com.
    link: /authors/
    linkText: Author a tutorial
  - title: For Platform Engineers
    details: Local dev, architecture, operations, and reference for the team running the platform.
    link: /developers/
    linkText: Engineer's guide
  - title: Historic
    details: How AEM, IMS, and the legacy migrations worked — for context when reading older code.
    link: /historic/
    linkText: How it used to be
---
```

(The cross-cutting links section pointing at `improvements.md`/`TODO.md`/`pilot-status.md` is intentionally dropped from the public homepage. Those files remain on disk and are reachable from the GitHub repo for engineers.)

- [ ] **Step 3: Verify in browser**

```bash
npm run docs:dev
```

Open `http://localhost:5173/tutorials-poc/`. Confirm:
- Hero with "SAP Tutorials Platform" title + tagline + logo + two action buttons.
- Four feature cards, each linking to the persona landing page.
- No console errors.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add docs/README.md
git commit -m "docs(vitepress): replace persona index with home layout frontmatter"
```

---

## Task 8: Flesh out the manual sidebar configuration

**Why now:** With the home page in place and link sweep clean, the build's last failing surface is unregistered persona pages.

**Files:**
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Enumerate the on-disk pages per persona**

```bash
fd -e md . docs/end-users docs/authors docs/historic | sort
fd -e md . docs/developers | sort
```

Note every page. The `developers/` set will be sub-grouped (Architecture / Operations / Reference) per the spec; `developers/getting-started.md` and `developers/README.md` go in an "Overview" group.

- [ ] **Step 2: Replace the sidebar block**

Edit `docs/.vitepress/config.ts` and replace the four stub sidebar blocks with the full structure:

```ts
sidebar: {
  '/end-users/': [
    { text: 'End Users', items: [
      { text: 'Overview',                  link: '/end-users/' },
      { text: 'Getting started',           link: '/end-users/getting-started' },
      { text: 'Using Joule chat',          link: '/end-users/using-joule-chat' },
      { text: 'Progress and completions',  link: '/end-users/progress-and-completions' },
      { text: 'Privacy and cookies',       link: '/end-users/privacy-and-cookies' },
      { text: 'Accessibility',             link: '/end-users/accessibility' }
    ]}
  ],

  '/authors/': [
    { text: 'Authors', items: [
      { text: 'Overview',                  link: '/authors/' },
      { text: 'Writing tutorials',         link: '/authors/writing-tutorials' },
      { text: 'Repo / group owners',       link: '/authors/repo-group-owners' },
      { text: 'Center admin',              link: '/authors/center-admin' },
      { text: 'Analytics admin',           link: '/authors/analytics-admin' }
    ]}
  ],

  '/developers/': [
    { text: 'Overview', items: [
      { text: 'Persona index',  link: '/developers/' },
      { text: 'Getting started', link: '/developers/getting-started' }
    ]},
    { text: 'Architecture', items: [
      // ... fill from `fd -e md docs/developers/architecture | sort`
    ]},
    { text: 'Operations', items: [
      // ... fill from `fd -e md docs/developers/operations | sort`
    ]},
    { text: 'Reference', collapsed: true, items: [
      // ... fill from `fd -e md docs/developers/reference | sort`
    ]}
  ],

  '/historic/': [
    { text: 'Historic', items: [
      // ... fill alphabetically from `fd -e md docs/historic | sort`
    ]}
  ]
}
```

Fill the `// ...` blocks with one `{ text, link }` per `.md` file from the listings in Step 1. `text` is the human-readable title (read each file's H1 if the filename isn't self-explanatory); `link` is `/<persona>/<basename-without-.md>` (or `/<persona>/<subfolder>/<basename>` for `developers/architecture/...` etc).

- [ ] **Step 3: Run the sidebar check**

```bash
node scripts/check-docs-sidebar.cjs
```

Expected: `check-docs-sidebar: ok (N pages, M links)`. If it lists unregistered pages, add them; if it lists dead links, fix the typo.

- [ ] **Step 4: Run a full build**

```bash
npm run docs:build
```

Expected: predocs:build runs (font copy + sidebar check, both ok), then `vitepress build docs` completes with `build complete in <N>s`. Zero dead-link errors.

If the build reports dead links: each error names a file:line — open it with `Edit` and rewrite or remove the link. Re-run until clean.

- [ ] **Step 5: Smoke the built site**

```bash
npm run docs:preview
```

Open `http://localhost:4173/tutorials-poc/`. Click through each persona's sidebar — every link must resolve. Search box (`Ctrl+K`) returns hits for "publish-content" and "QA channel".

Stop the preview server.

- [ ] **Step 6: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "docs(vitepress): populate sidebar with all four persona blocks"
```

---

## Task 9: Author-facing maintenance note

**Files:**
- Modify: `docs/authors/README.md`

- [ ] **Step 1: Append the note**

Open `docs/authors/README.md` and append the section below (above any `---` footer if present). The outer 4-backtick fence is just this plan's display wrapper — paste only the inner content (starting at `## Updating the docs site sidebar` and ending after the closing 3-backtick fence on the bash example):

````markdown
## Updating the docs site sidebar

When you add a new page under `docs/end-users/`, `docs/authors/`, `docs/developers/`, or `docs/historic/`, you must register it in the sidebar at [`docs/.vitepress/config.ts`](../.vitepress/config.ts) under the matching persona block. The build runs `scripts/check-docs-sidebar.cjs` as `predocs:build` — it fails with a clear diff if a page is unregistered or a link is dead.

Run locally to verify:

```bash
npm run docs:build
```
````

- [ ] **Step 2: Commit**

```bash
git add docs/authors/README.md
git commit -m "docs(authors): document the docs-site sidebar maintenance contract"
```

---

## Task 10: Update root `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the Documentation section**

```bash
grep -n '^### Documentation' CLAUDE.md
```

(Section exists at the file's tail — the docs persona index lives there.)

- [ ] **Step 2: Append docs-site coordinates**

Inside the Documentation section, immediately after the `docs/README.md` bullet, add:

```markdown

The same persona docs are published as a public VitePress site at https://sap-tutorials.github.io/tutorials-poc/. Build commands:

- `npm run docs:dev` — local preview at http://localhost:5173/tutorials-poc/
- `npm run docs:build` — production build (runs sidebar guard + font copy first)
- `npm run docs:preview` — preview the built site

Sidebar maintenance: `docs/.vitepress/config.ts` `themeConfig.sidebar`. The `predocs:build` check rejects unregistered pages or dead links.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document the public VitePress site URL and build commands"
```

---

## Task 11: Final integration build

**Files:** none modified — this is a verification task.

- [ ] **Step 1: Clean the cache and dist**

```bash
rm -rf docs/.vitepress/dist docs/.vitepress/cache docs/.vitepress/public/fonts
```

(The font copy script is idempotent, so this also tests the cold-cache path.)

- [ ] **Step 2: Full build from cold cache**

```bash
time npm run docs:build
```

Expected: completes in well under 90 seconds. Note the wall time for comparison with the workflow run later.

- [ ] **Step 3: Sanity-check the output**

```bash
ls docs/.vitepress/dist/index.html docs/.vitepress/dist/end-users/index.html docs/.vitepress/dist/fonts/72-Regular.woff2
```

All three paths must exist.

- [ ] **Step 4: Run npm test (regression check)**

```bash
npm test
```

Expected: existing unit suite continues to pass. The two new test files under `test/unit/docs-tooling/` are picked up by the existing `unit` workspace and pass alongside everything else.

- [ ] **Step 5: No commit needed**

This task only verifies. If anything fails, fix it in a fresh task or amend the relevant earlier task's commit (only if the issue is local to that task — otherwise commit the fix as its own follow-up).

---

## Task 12: GitHub Actions Pages workflow (phase 1: no auto-deploy)

**Files:**
- Create: `.github/workflows/docs-deploy.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Deploy Docs to GitHub Pages

on:
  # Phase 1: workflow_dispatch only. Tom uncomments the push trigger after the first manual deploy.
  # push:
  #   branches: [main]
  #   paths:
  #     - 'docs/**'
  #     - '.github/workflows/docs-deploy.yml'
  #     - 'package.json'
  #     - 'package-lock.json'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Validate YAML syntax**

```bash
yq '.jobs.build.steps[].run' .github/workflows/docs-deploy.yml
```

Expected: prints the two `run` commands with no error.

- [ ] **Step 3: Verify the trigger really is dispatch-only**

```bash
yq '.on' .github/workflows/docs-deploy.yml
```

Expected: just `workflow_dispatch:` (or `workflow_dispatch: null` from yq normalization). The push block must be commented.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/docs-deploy.yml
git commit -m "feat(docs): add GitHub Pages deploy workflow (phase 1: dispatch-only)"
```

---

## Task 13: Open the PR

**Files:** none modified — this is the handoff to Tom.

- [ ] **Step 1: Confirm the branch is clean**

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: clean tree, ~12 commits on the branch (one per task that committed, plus the spec commits).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin docs/vitepress-site
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "docs: VitePress public docs site (phase 1: build, no publish)" --body "$(cat <<'EOF'
## Summary

- Stands up a VitePress 1.6.x site for `docs/` with custom Horizon (Fiori Fundamentals) theming via CSS-only bridge, light + dark with OS auto-detect, self-hosted SAP "72" font.
- Adds GitHub Pages deploy workflow at `.github/workflows/docs-deploy.yml` — currently `workflow_dispatch`-only. The `on.push` block is committed but commented out.
- Adds two helper scripts with vitest coverage: `scripts/copy-sap-fonts.cjs` (predocs:dev/build) and `scripts/check-docs-sidebar.cjs` (predocs:build sidebar guard).
- Replaces the `docs/README.md` body with a home-layout hero + 4 feature cards (End Users / Authors / Developers / Historic).
- Keeps `improvements.md`, `TODO.md`, `pilot-status.md`, `superpowers/**` out of the public site via top-level `srcExclude`.

## Spec

[docs/superpowers/specs/2026-05-25-vitepress-docs-site-design.md](./docs/superpowers/specs/2026-05-25-vitepress-docs-site-design.md)

## Phase 2 (after this PR merges)

1. Repo Settings → Pages → set source to "GitHub Actions".
2. Run `Deploy Docs to GitHub Pages` once via `workflow_dispatch`.
3. Verify https://sap-tutorials.github.io/tutorials-poc/ returns 200 and renders Horizon styling.
4. Uncomment the `on.push` block in `docs-deploy.yml` in a follow-up commit.

Backout: set Pages source back to "None" in repo settings — site goes 404 immediately, no other deploys affected.

## Test plan

- [x] `npm test` — full unit suite incl. new `test/unit/docs-tooling/*` files
- [x] `npm run docs:build` — cold-cache full build under 90s, zero dead links
- [x] `npm run docs:preview` — manual click-through every persona, search returns hits for "publish-content" and "QA channel"
- [x] DevTools → Network: `72-Regular.woff2` and `72-Bold.woff2` load from `/tutorials-poc/fonts/`
- [x] Light/dark toggle persists; OS dark mode honored on first visit (clear localStorage + reload)
EOF
)"
```

- [ ] **Step 4: Hand off**

Paste the PR URL into the conversation and stop. Phase-2 enablement (Pages source = "GitHub Actions" + dispatch the first run) is Tom's manual step.
