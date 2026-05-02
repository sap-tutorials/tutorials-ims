import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { discoverTutorials, computeLocalHashes, computeDiff, buildPayload } from '../publish-content.js';

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
