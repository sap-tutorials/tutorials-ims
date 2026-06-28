import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spawn-based test for scripts/check-icon-imports.ts.
//
// We invoke the script in a child process against a synthetic repo root
// (CHECK_ICON_IMPORTS_ROOT env var) so each test exercises the real CLI
// surface — exit code, stdout/stderr, the works. tsx is used to run the
// .ts file directly, mirroring how `postbuild:apps` / package.json
// scripts run other tsx-based check scripts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-icon-imports.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'icon-check-'));
  mkdirSync(join(root, 'hugo', 'layouts'), { recursive: true });
  mkdirSync(join(root, 'hugo', 'assets', 'js'), { recursive: true });
  mkdirSync(join(root, 'hugo-apps', 'src'), { recursive: true });
  return root;
}

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function run(root: string): RunResult {
  // Use tsx (already a project dep) so we run the .ts file directly,
  // matching how postbuild:apps / package.json scripts execute it.
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT], {
      env: { ...process.env, CHECK_ICON_IMPORTS_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // Windows needs shell to resolve npx.cmd
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    // execFileSync throws on non-zero exit; the err object carries
    // stdout/stderr/status the same way Node's child_process.spawnSync
    // reports them.
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('scripts/check-icon-imports.ts', () => {
  let root: string;
  beforeEach(() => { root = fixture(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes when every static icon attribute has a matching import', () => {
    writeFile(root, 'hugo/layouts/partials/header.html', `
      <ui5-shellbar-item icon="search" text="Search"></ui5-shellbar-item>
      <ui5-shellbar-item icon="dark-mode" text="Theme"></ui5-shellbar-item>
    `);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts', `
      import "@ui5/webcomponents-icons/dist/search.js";
      import "@ui5/webcomponents-icons/dist/dark-mode.js";
    `);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK — 2 unique icon\(s\)/);
  });

  it('fails listing the missing icon name with file:line', () => {
    // This is the exact #262 shape: the layout references the icon, but
    // the bootstrap forgot to import the module.
    writeFile(root, 'hugo/layouts/partials/header.html',
      `<ui5-shellbar-item icon="bbyd-active-sales" text="Browse"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/search.js";\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/icon="bbyd-active-sales" is not imported/);
    expect(r.stderr).toMatch(/header\.html:1/);
    expect(r.stderr).toMatch(/import "@ui5\/webcomponents-icons\/dist\/bbyd-active-sales\.js"/);
  });

  it('ignores commented-out icon attributes', () => {
    writeFile(root, 'hugo/layouts/partials/header.html', `
      <!-- <ui5-shellbar-item icon="ghost-icon" text="Old"></ui5-shellbar-item> -->
      <ui5-shellbar-item icon="search" text="Search"></ui5-shellbar-item>
    `);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/search.js";\n`);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('ignores commented-out registrations (does not count them as imported)', () => {
    writeFile(root, 'hugo/layouts/partials/header.html',
      `<ui5-shellbar-item icon="search" text="Search"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts', `
      // import "@ui5/webcomponents-icons/dist/search.js";
      // (commented out, so the layout reference should be flagged)
    `);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/icon="search" is not imported/);
  });

  it('ignores Hugo template expressions and dynamic Vue bindings', () => {
    writeFile(root, 'hugo/layouts/partials/header.html', `
      <ui5-shellbar-item icon="{{ .Foo }}" text="Templated"></ui5-shellbar-item>
      <ui5-shellbar-item :icon="dynamicName" text="Dynamic Vue"></ui5-shellbar-item>
      <ui5-shellbar-item data-icon="not-ui5" text="data attr"></ui5-shellbar-item>
    `);
    // No registrations needed — the static-icon set is empty.
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/dark-mode.js";\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 unique icon\(s\) referenced/);
  });

  it('counts a registration anywhere on the JS surface (not just bootstrap)', () => {
    // Some islands legitimately import their own icons — accept that.
    writeFile(root, 'hugo/layouts/partials/header.html',
      `<ui5-shellbar-item icon="accept" text="OK"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `// no icons imported here\n`);
    writeFile(root, 'hugo-apps/src/validation/index.ts',
      `import "@ui5/webcomponents-icons/dist/accept.js";\n`);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('skips test fixtures under __tests__/ to avoid double-reporting', () => {
    // Fixture HTML is a snapshot of layouts we already lint — counting it
    // twice would create noise. Bootstrap has no imports, so if the
    // fixture WERE scanned we'd see a failure. We expect a clean pass.
    writeFile(root, 'hugo-apps/src/browse/__tests__/fixtures/page.html',
      `<ui5-shellbar-item icon="search" text="Search"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/dark-mode.js";\n`);
    // Add a real layout usage of dark-mode so we have at least one usage —
    // the script fails-by-design when usages == 0 (regex-drift sentinel).
    writeFile(root, 'hugo/layouts/partials/header.html',
      `<ui5-shellbar-item icon="dark-mode" text="Theme"></ui5-shellbar-item>\n`);
    const r = run(root);
    expect(r.status).toBe(0);
  });

  it('groups multiple call-sites of the same missing icon into one error block', () => {
    writeFile(root, 'hugo/layouts/partials/header.html',
      `<ui5-shellbar-item icon="missing" text="A"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/layouts/partials/footer.html',
      `<ui5-shellbar-item icon="missing" text="B"></ui5-shellbar-item>\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/dark-mode.js";\n`);
    // Provide a real usage so the regex-drift sentinel doesn't fire.
    writeFile(root, 'hugo/layouts/partials/main.html',
      `<ui5-shellbar-item icon="dark-mode" text="OK"></ui5-shellbar-item>\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    // Only one ERROR header for "missing", but both call-sites listed.
    const errCount = (r.stderr.match(/ERROR: icon="missing"/g) ?? []).length;
    expect(errCount).toBe(1);
    expect(r.stderr).toMatch(/header\.html:1/);
    expect(r.stderr).toMatch(/footer\.html:1/);
  });

  // The Hugo `dict "icon" "<name>"` pattern (verb-spine.html shape).
  // Icon names declared inside Hugo template data don't surface to the
  // attribute-style ICON_RE because Hugo evaluates the template AFTER
  // the static guard runs. These two cases lock in HUGO_DICT_ICON_RE.
  it('passes when Hugo dict "icon" "<name>" has a matching import', () => {
    writeFile(root, 'hugo/layouts/partials/homepage/verb-spine.html',
      `{{- \$verbDefs := slice (dict "key" "FOO" "icon" "learning-assistant") -}}\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/learning-assistant.js";\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 unique icon\(s\) referenced/);
  });

  it('fails when Hugo dict "icon" "<name>" has no matching import', () => {
    writeFile(root, 'hugo/layouts/partials/homepage/verb-spine.html',
      `{{- \$verbDefs := slice (dict "key" "FOO" "icon" "learning-assistant") -}}\n`);
    writeFile(root, 'hugo/assets/js/ui5-bootstrap.ts',
      `import "@ui5/webcomponents-icons/dist/dark-mode.js";\n`);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/icon="learning-assistant" is not imported/);
    expect(r.stderr).toMatch(/verb-spine\.html:1/);
    expect(r.stderr).toMatch(/import "@ui5\/webcomponents-icons\/dist\/learning-assistant\.js"/);
  });
});
