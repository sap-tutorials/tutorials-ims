// Guard for the subsetted OpenDyslexic web font (#1979).
//
// A future re-vendor of OpenDyslexic must not silently (a) re-bloat back to the
// full ~115 KB charset, or (b) ship a subset missing required prose glyphs. We
// can't decode WOFF2 in-test without a font parser dependency, so this guard
// chains three cheap, CI-safe checks:
//   1. Both files exist and are real WOFF2 (`wOF2` magic).
//   2. Each file is within an expected size band (a full-charset re-vendor blows
//      the ceiling; an empty/broken subset blows the floor).
//   3. A committed manifest — written by scripts/subset-opendyslexic.mjs, which
//      verifies coverage against the actual font cmap at subset time — declares
//      the covered ranges, and those ranges cover every REQUIRED range. The
//      manifest's recorded byte sizes must match the files on disk, so the
//      manifest can't drift from what's shipped.
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { REQUIRED_RANGES } from '../../scripts/opendyslexic-unicodes.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fontsDir = path.join(root, 'hugo/static/fonts');
const WEIGHTS = ['OpenDyslexic-Regular.woff2', 'OpenDyslexic-Bold.woff2'];
const SIZE_FLOOR = 15_000; // below this the subset is suspiciously empty/broken
const SIZE_CEIL = 70_000; // above this someone re-vendored a wider/full charset

describe('OpenDyslexic subset guard (#1979)', () => {
  for (const file of WEIGHTS) {
    it(`${file} exists, is real WOFF2, and within the size band`, () => {
      const buf = readFileSync(path.join(fontsDir, file));
      expect(buf.subarray(0, 4).toString('latin1'), `${file} WOFF2 magic`).toBe('wOF2');
      const size = buf.length;
      expect(size, `${file} not suspiciously small`).toBeGreaterThan(SIZE_FLOOR);
      expect(size, `${file} not re-bloated to full charset`).toBeLessThan(SIZE_CEIL);
    });
  }

  it('coverage manifest exists and covers every required range', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(fontsDir, 'opendyslexic.subset.json'), 'utf8'),
    );
    const declared = new Set(manifest.unicodes);
    for (const r of REQUIRED_RANGES) {
      expect(declared.has(r.unicodes), `manifest must declare ${r.name} (${r.unicodes})`).toBe(true);
    }
  });

  it('manifest recorded sizes match the shipped files (no drift)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(fontsDir, 'opendyslexic.subset.json'), 'utf8'),
    );
    for (const file of WEIGHTS) {
      const actual = statSync(path.join(fontsDir, file)).size;
      expect(manifest.files[file], `manifest size for ${file}`).toBe(actual);
    }
  });
});
