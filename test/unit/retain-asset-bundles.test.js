import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHashedFiles } from '../../scripts/retain-asset-bundles.cjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ret-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectHashedFiles', () => {
  it('returns only hashed bundle filenames, ignoring unhashed and non-js/css', () => {
    writeFileSync(join(dir, 'embed-Coqc9fp6.js'), '');
    writeFileSync(join(dir, 'consent-trustarc.js'), '');   // unhashed → ignored
    writeFileSync(join(dir, 'notes.txt'), '');             // non-bundle → ignored
    const got = collectHashedFiles(dir).sort();
    expect(got).toEqual(['embed-Coqc9fp6.js']);
  });

  it('returns [] for a missing directory', () => {
    expect(collectHashedFiles(join(dir, 'nope'))).toEqual([]);
  });
});
