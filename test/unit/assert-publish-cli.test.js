// test/unit/assert-publish-cli.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAssertSpecs } from '../../scripts/lib/publish-asserts.js';

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'assert-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('collectAssertSpecs', () => {
  it('flattens specs from every *.assert.json and stamps slug onto each', () => {
    writeFileSync(path.join(dir, 'alpha.assert.json'), JSON.stringify({
      slug: 'alpha',
      specs: [
        { index: 0, stepNumber: 1, type: 'cmd', run: 'x', expectExit: 0 },
        { index: 1, stepNumber: 1, type: 'file', filePath: 'a', expectContains: false },
      ],
    }));
    writeFileSync(path.join(dir, 'beta.assert.json'), JSON.stringify({
      slug: 'beta', specs: [{ index: 0, stepNumber: 2, type: 'http', method: 'GET', path: '/x', expectStatus: 200 }],
    }));
    const out = collectAssertSpecs(dir);
    expect(out).toHaveLength(3);
    expect(out.every(s => typeof s.slug === 'string')).toBe(true);
    expect(out.filter(s => s.slug === 'alpha')).toHaveLength(2);
  });

  it('skips malformed sidecars and non-matching files; returns [] on missing dir', () => {
    writeFileSync(path.join(dir, 'bad.assert.json'), '{not json');
    writeFileSync(path.join(dir, 'nospecs.assert.json'), JSON.stringify({ slug: 'x' }));
    writeFileSync(path.join(dir, 'ignore.txt'), 'nope');
    expect(collectAssertSpecs(dir)).toHaveLength(0);
    expect(collectAssertSpecs(path.join(dir, 'does-not-exist'))).toHaveLength(0);
  });
});
