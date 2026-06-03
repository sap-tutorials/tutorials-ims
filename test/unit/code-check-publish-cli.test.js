import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { collectCodeCheckSpecs } from '../../scripts/lib/publish-codecheck.js';

describe('collectCodeCheckSpecs', () => {
  it('collects all codecheck.json sidecars in cacheDir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    writeFileSync(path.join(dir, 'a.codecheck.json'),
      JSON.stringify({ slug: 'a', specs: [{ stepNumber: 2, goal: 'g1' }] }));
    writeFileSync(path.join(dir, 'b.codecheck.json'),
      JSON.stringify({ slug: 'b', specs: [{ stepNumber: 1, goal: 'g2' }] }));
    // unrelated file should be ignored
    writeFileSync(path.join(dir, 'a.json'), '{}');

    const out = collectCodeCheckSpecs(dir);
    expect(out).toHaveLength(2);
    expect(out.map(s => s.slug).sort()).toEqual(['a', 'b']);
    expect(out.find(s => s.slug === 'a').stepNumber).toBe(2);
  });

  it('returns empty array for an empty cache dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-empty-'));
    const out = collectCodeCheckSpecs(dir);
    expect(out).toEqual([]);
  });

  it('skips malformed JSON silently, processes other sidecars successfully', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-bad-'));
    writeFileSync(path.join(dir, 'bad.codecheck.json'), '{ not valid json !!');
    writeFileSync(path.join(dir, 'good.codecheck.json'),
      JSON.stringify({ slug: 'good', specs: [{ stepNumber: 3, goal: 'works fine' }] }));

    const out = collectCodeCheckSpecs(dir);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('good');
    expect(out[0].stepNumber).toBe(3);
    expect(out[0].goal).toBe('works fine');
  });

  it('flattens multiple specs in the specs array, each row gets slug + spread fields', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-multi-'));
    writeFileSync(path.join(dir, 'multi.codecheck.json'), JSON.stringify({
      slug: 'multi-tutorial',
      specs: [
        { stepNumber: 1, goal: 'first goal', language: 'JavaScript', hints: ['hint a'] },
        { stepNumber: 4, goal: 'fourth goal', referenceSolution: 'console.log("x")' },
        { stepNumber: 7, goal: 'seventh goal' },
      ]
    }));

    const out = collectCodeCheckSpecs(dir);
    expect(out).toHaveLength(3);

    const step1 = out.find(s => s.stepNumber === 1);
    expect(step1).toBeDefined();
    expect(step1.slug).toBe('multi-tutorial');
    expect(step1.goal).toBe('first goal');
    expect(step1.language).toBe('JavaScript');
    expect(step1.hints).toEqual(['hint a']);

    const step4 = out.find(s => s.stepNumber === 4);
    expect(step4.referenceSolution).toBe('console.log("x")');
    expect(step4.slug).toBe('multi-tutorial');

    const step7 = out.find(s => s.stepNumber === 7);
    expect(step7.goal).toBe('seventh goal');
  });

  it('returns empty array when cache dir does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'cc-does-not-exist-' + Date.now());
    const out = collectCodeCheckSpecs(nonExistent);
    expect(out).toEqual([]);
  });

  it('skips sidecar files that are missing slug or specs fields', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-missing-fields-'));
    // missing slug
    writeFileSync(path.join(dir, 'no-slug.codecheck.json'),
      JSON.stringify({ specs: [{ stepNumber: 1, goal: 'g' }] }));
    // missing specs array
    writeFileSync(path.join(dir, 'no-specs.codecheck.json'),
      JSON.stringify({ slug: 'tut', goal: 'g' }));
    // specs is not an array
    writeFileSync(path.join(dir, 'specs-not-array.codecheck.json'),
      JSON.stringify({ slug: 'tut2', specs: 'oops' }));
    // valid one to confirm others don't corrupt the result
    writeFileSync(path.join(dir, 'valid.codecheck.json'),
      JSON.stringify({ slug: 'valid', specs: [{ stepNumber: 2, goal: 'ok' }] }));

    const out = collectCodeCheckSpecs(dir);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('valid');
  });
});
