import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { discoverTutorials, computeLocalHashes, computeDiff, buildPayload, validateProductionBuild, extractMetadata, extractBodyText, extractAllBodyTexts } from '../publish-content.js';

const TEST_DIR = join(tmpdir(), `publish-content-test-${Date.now()}`);
const HUGO_DIR = join(TEST_DIR, 'public');
const TUTORIALS_DIR = join(HUGO_DIR, 'tutorials');

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

beforeAll(() => {
  mkdirSync(join(TUTORIALS_DIR, 'tutorial-alpha'), { recursive: true });
  mkdirSync(join(TUTORIALS_DIR, 'tutorial-beta'), { recursive: true });
  mkdirSync(join(TUTORIALS_DIR, 'tutorial-gamma'), { recursive: true });

  writeFileSync(join(TUTORIALS_DIR, 'tutorial-alpha', 'index.html'), '<h1>Alpha</h1>');
  writeFileSync(join(TUTORIALS_DIR, 'tutorial-beta', 'index.html'), '<h1>Beta</h1>');
  writeFileSync(join(TUTORIALS_DIR, 'tutorial-gamma', 'index.html'), '<h1>Gamma</h1>');

  // non-tutorial file that should be ignored
  writeFileSync(join(TUTORIALS_DIR, 'stray-file.txt'), 'not a tutorial');
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('discoverTutorials', () => {
  it('finds all tutorial slugs with index.html', () => {
    const tutorials = discoverTutorials(HUGO_DIR);

    expect(tutorials.size).toBe(3);
    expect(tutorials.has('tutorial-alpha')).toBe(true);
    expect(tutorials.has('tutorial-beta')).toBe(true);
    expect(tutorials.has('tutorial-gamma')).toBe(true);
  });

  it('returns file paths ending in index.html', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    for (const [, filePath] of tutorials) {
      expect(filePath).toMatch(/index\.html$/);
    }
  });

  it('returns empty map for non-existent directory', () => {
    const tutorials = discoverTutorials('/does/not/exist');
    expect(tutorials.size).toBe(0);
  });

  it('ignores entries without index.html', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    expect(tutorials.has('stray-file.txt')).toBe(false);
  });
});

describe('computeLocalHashes', () => {
  it('returns SHA-256 hex hashes for each tutorial', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const hashes = computeLocalHashes(tutorials);

    expect(hashes.size).toBe(3);
    expect(hashes.get('tutorial-alpha')).toBe(sha256('<h1>Alpha</h1>'));
    expect(hashes.get('tutorial-beta')).toBe(sha256('<h1>Beta</h1>'));
  });

  it('produces 64-character hex strings', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const hashes = computeLocalHashes(tutorials);

    for (const [, hash] of hashes) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe('computeDiff', () => {
  it('identifies new slugs not in remote', () => {
    const local = new Map([
      ['slug-a', 'hash-a'],
      ['slug-b', 'hash-b'],
    ]);
    const remote = {};

    const diff = computeDiff(local, remote);
    expect(diff).toHaveLength(2);
    expect(diff).toContain('slug-a');
    expect(diff).toContain('slug-b');
  });

  it('identifies changed slugs with different hashes', () => {
    const local = new Map([
      ['slug-a', 'new-hash-a'],
      ['slug-b', 'same-hash-b'],
    ]);
    const remote = { 'slug-a': 'old-hash-a', 'slug-b': 'same-hash-b' };

    const diff = computeDiff(local, remote);
    expect(diff).toEqual(['slug-a']);
  });

  it('returns empty array when everything matches', () => {
    const local = new Map([
      ['slug-a', 'hash-a'],
      ['slug-b', 'hash-b'],
    ]);
    const remote = { 'slug-a': 'hash-a', 'slug-b': 'hash-b' };

    const diff = computeDiff(local, remote);
    expect(diff).toHaveLength(0);
  });

  it('ignores remote slugs not present locally (deleted tutorials)', () => {
    const local = new Map([['slug-a', 'hash-a']]);
    const remote = { 'slug-a': 'hash-a', 'slug-deleted': 'hash-x' };

    const diff = computeDiff(local, remote);
    expect(diff).toHaveLength(0);
  });
});

describe('buildPayload', () => {
  it('produces gzipped base64 that decompresses to original HTML', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const payload = buildPayload(['tutorial-alpha'], tutorials);

    expect(Object.keys(payload)).toEqual(['tutorial-alpha']);

    const compressed = Buffer.from(payload['tutorial-alpha'], 'base64');
    const decompressed = gunzipSync(compressed).toString('utf-8');
    expect(decompressed).toBe('<h1>Alpha</h1>');
  });

  it('handles multiple slugs', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const payload = buildPayload(['tutorial-alpha', 'tutorial-beta'], tutorials);

    expect(Object.keys(payload).sort()).toEqual(['tutorial-alpha', 'tutorial-beta']);

    const betaContent = gunzipSync(Buffer.from(payload['tutorial-beta'], 'base64')).toString();
    expect(betaContent).toBe('<h1>Beta</h1>');
  });

  it('skips slugs not found in tutorials map', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const payload = buildPayload(['non-existent'], tutorials);
    expect(Object.keys(payload)).toHaveLength(0);
  });
});

describe('extractMetadata', () => {
  const META_DIR = join(TEST_DIR, 'content', 'tutorials');

  beforeAll(() => {
    mkdirSync(META_DIR, { recursive: true });

    writeFileSync(join(META_DIR, 'my-tutorial.md'), [
      '---',
      'title: My Tutorial Title',
      'description: A test tutorial',
      'time: 15',
      'level: beginner',
      'primaryTag: topic>cap',
      'stepCount: 3',
      'lastUpdated: 2026-05-20',
      'contributors:',
      '  - login: "thomasjung-sap"',
      '    name: "Thomas Jung"',
      '    email: "thomas.jung@sap.com"',
      'steps:',
      '  - number: 1',
      '    title: First Step',
      '  - number: 2',
      '    title: Second Step',
      '  - number: 3',
      '    title: Third Step',
      '---',
      '',
      '# My Tutorial Title',
      'Content here.',
    ].join('\n'));

    writeFileSync(join(META_DIR, 'minimal.md'), [
      '---',
      'title: Minimal',
      '---',
      '',
      'Body.',
    ].join('\n'));

    writeFileSync(join(META_DIR, 'no-frontmatter.md'), '# Just a heading\nNo YAML here.');
  });

  it('extracts full metadata from Hugo content markdown', () => {
    const result = extractMetadata(META_DIR, ['my-tutorial']);

    expect(result['my-tutorial']).toBeDefined();
    const meta = result['my-tutorial'];
    expect(meta.title).toBe('My Tutorial Title');
    expect(meta.description).toBe('A test tutorial');
    expect(meta.time).toBe(15);
    expect(meta.level).toBe('beginner');
    expect(meta.primaryTag).toBe('topic>cap');
    expect(meta.stepCount).toBe(3);
    expect(meta.steps).toHaveLength(3);
    expect(meta.steps[0]).toEqual({ number: 1, title: 'First Step' });
    expect(meta.steps[2]).toEqual({ number: 3, title: 'Third Step' });
    expect(result['my-tutorial'].lastUpdated).toBe('2026-05-20');
    expect(result['my-tutorial'].primaryContributorEmail).toBe('thomas.jung@sap.com');
    expect(result['my-tutorial'].primaryContributorLogin).toBe('thomasjung-sap');
  });

  it('handles minimal frontmatter with defaults', () => {
    const result = extractMetadata(META_DIR, ['minimal']);

    expect(result['minimal']).toBeDefined();
    const meta = result['minimal'];
    expect(meta.title).toBe('Minimal');
    expect(meta.description).toBe('');
    expect(meta.time).toBeNull();
    expect(meta.level).toBeNull();
    expect(meta.primaryTag).toBeNull();
    expect(meta.steps).toHaveLength(0);
    expect(meta.stepCount).toBe(0);
    expect(meta.lastUpdated).toBeNull();
    expect(meta.primaryContributorEmail).toBeNull();
    expect(meta.primaryContributorLogin).toBeNull();
  });

  it('skips files without YAML frontmatter', () => {
    const result = extractMetadata(META_DIR, ['no-frontmatter']);
    expect(result['no-frontmatter']).toBeUndefined();
  });

  it('skips slugs whose .md file does not exist', () => {
    const result = extractMetadata(META_DIR, ['nonexistent-slug']);
    expect(result['nonexistent-slug']).toBeUndefined();
  });

  it('processes multiple slugs in one call', () => {
    const result = extractMetadata(META_DIR, ['my-tutorial', 'minimal', 'nonexistent-slug']);
    expect(Object.keys(result).sort()).toEqual(['minimal', 'my-tutorial']);
  });
});

describe('validateProductionBuild', () => {
  const VAL_DIR = join(TEST_DIR, 'val-public', 'tutorials');

  beforeAll(() => {
    mkdirSync(join(VAL_DIR, 'clean-tutorial'), { recursive: true });
    writeFileSync(
      join(VAL_DIR, 'clean-tutorial', 'index.html'),
      '<html data-cap-base=""><body>Clean</body></html>'
    );
  });

  it('passes for production-built content', () => {
    const tutorials = discoverTutorials(join(TEST_DIR, 'val-public'));
    const violations = validateProductionBuild(tutorials);
    expect(violations).toHaveLength(0);
  });

  it('catches localhost cap-base (dev build artifact)', () => {
    const devDir = join(TEST_DIR, 'dev-public', 'tutorials', 'dev-tutorial');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(
      join(devDir, 'index.html'),
      '<html data-cap-base="http://localhost:4004"><body>Dev</body></html>'
    );

    const tutorials = discoverTutorials(join(TEST_DIR, 'dev-public'));
    const violations = validateProductionBuild(tutorials);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('localhost');
  });

  it('catches livereload script injection', () => {
    const lrDir = join(TEST_DIR, 'lr-public', 'tutorials', 'lr-tutorial');
    mkdirSync(lrDir, { recursive: true });
    writeFileSync(
      join(lrDir, 'index.html'),
      '<html data-cap-base=""><script src="/livereload.js"></script></html>'
    );

    const tutorials = discoverTutorials(join(TEST_DIR, 'lr-public'));
    const violations = validateProductionBuild(tutorials);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('livereload');
  });
});

describe('extractBodyText', () => {
  it('extracts text from <main class="tutorial-main"> when present', () => {
    const html = `<html><body>
      <header>Site header noise</header>
      <main><nav>breadcrumbs</nav>
        <main class="tutorial-main">
          <h1>HANA Cloud Setup</h1>
          <p>Learn to configure HANA Cloud with the BTP cockpit.</p>
        </main>
      </main>
      <footer>Footer noise</footer>
    </body></html>`;

    const text = extractBodyText(html);
    expect(text).toContain('HANA Cloud Setup');
    expect(text).toContain('configure HANA Cloud');
    expect(text).not.toContain('Site header noise');
    expect(text).not.toContain('Footer noise');
    expect(text).not.toContain('breadcrumbs');
  });

  it('falls back to <body> when tutorial-main is absent', () => {
    const html = `<html><body><h1>Plain Page</h1><p>Some text content</p></body></html>`;
    const text = extractBodyText(html);
    expect(text).toContain('Plain Page');
    expect(text).toContain('Some text content');
  });

  it('strips <script> and <style> blocks', () => {
    const html = `<body><main class="tutorial-main">
      <script>alert('secret password')</script>
      <style>.foo { color: red; }</style>
      <p>Visible text</p>
    </main></body>`;

    const text = extractBodyText(html);
    expect(text).toContain('Visible text');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('secret password');
    expect(text).not.toContain('color: red');
  });

  it('decodes common HTML entities', () => {
    const html = `<body><main class="tutorial-main">
      <p>Use &amp; for AND, &lt;tag&gt; for tags, &quot;quoted&quot; strings, and non&nbsp;breaking spaces.</p>
    </main></body>`;

    const text = extractBodyText(html);
    expect(text).toContain('Use & for AND');
    expect(text).toContain('<tag> for tags');
    expect(text).toContain('"quoted" strings');
    expect(text).toContain('non breaking');
  });

  it('normalizes whitespace', () => {
    const html = `<body><main class="tutorial-main">
      <p>Multiple


       lines</p>
      <p>and    extra    spaces</p>
    </main></body>`;

    const text = extractBodyText(html);
    expect(text).not.toMatch(/\s{2,}/);
    expect(text).toContain('Multiple lines');
    expect(text).toContain('and extra spaces');
  });

  it('handles tutorial-main with single quotes and other class tokens', () => {
    const html = `<body><main class='content tutorial-main other'>
      <h1>Found me</h1>
    </main></body>`;
    const text = extractBodyText(html);
    expect(text).toContain('Found me');
  });
});

describe('extractAllBodyTexts', () => {
  it('builds a slug→text map for the discovered tutorials', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const slugs = [...tutorials.keys()];
    const result = extractAllBodyTexts(tutorials, slugs);

    for (const slug of slugs) {
      expect(result[slug]).toBeDefined();
      expect(typeof result[slug]).toBe('string');
    }
  });

  it('skips slugs not present in the tutorials map', () => {
    const tutorials = discoverTutorials(HUGO_DIR);
    const result = extractAllBodyTexts(tutorials, ['tutorial-alpha', 'does-not-exist']);
    expect(result['tutorial-alpha']).toBeDefined();
    expect(result['does-not-exist']).toBeUndefined();
  });
});
