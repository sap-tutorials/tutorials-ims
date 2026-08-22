// Required Unicode coverage for the subsetted OpenDyslexic web font (#1979).
//
// OpenDyslexic is applied ONLY to tutorial prose (`.op-body`) under the
// "easier-to-read font" toggle — code stays monospace, and OpenDyslexic is a
// Latin-only face upstream (no CJK/Cyrillic/Greek to lose). So the subset only
// needs prose glyphs: Latin + accented author names + smart typography.
//
// Shared by scripts/subset-opendyslexic.mjs (which subsets + verifies coverage)
// and test/unit/opendyslexic-subset.test.ts (the CI guard). Keep them in sync by
// importing from here — never hard-code the ranges in two places.

/** @typedef {{ name: string, unicodes: string }} Range */

/** @type {Range[]} */
export const REQUIRED_RANGES = [
  { name: 'Basic Latin', unicodes: 'U+0020-007E' },
  { name: 'Latin-1 Supplement', unicodes: 'U+00A0-00FF' },
  { name: 'Latin Extended-A', unicodes: 'U+0100-017F' },
  // Smart typography + common prose symbols authors actually use.
  { name: 'en dash', unicodes: 'U+2013' },
  { name: 'em dash', unicodes: 'U+2014' },
  { name: 'left single quote', unicodes: 'U+2018' },
  { name: 'right single quote', unicodes: 'U+2019' },
  { name: 'left double quote', unicodes: 'U+201C' },
  { name: 'right double quote', unicodes: 'U+201D' },
  { name: 'bullet', unicodes: 'U+2022' },
  { name: 'horizontal ellipsis', unicodes: 'U+2026' },
  { name: 'rightwards arrow', unicodes: 'U+2192' },
  { name: 'copyright', unicodes: 'U+00A9' },
  { name: 'trademark', unicodes: 'U+2122' },
  { name: 'euro', unicodes: 'U+20AC' },
];

/** Comma-joined `--unicodes` argument for `fontTools.subset`. */
export const UNICODES_ARG = REQUIRED_RANGES.map((r) => r.unicodes).join(',');
