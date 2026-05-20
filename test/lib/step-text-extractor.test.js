import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractStepText, MAX_CHUNK_CHARS } from '../../srv/lib/step-text-extractor.js';

const fixture = (name) =>
  gzipSync(readFileSync(join(import.meta.dirname, '../fixtures/step-extractor', name)));

describe('step-text-extractor', () => {
  it('extracts steps from v1 ACCORDION format', () => {
    const steps = extractStepText(fixture('v1-accordion.html'));
    expect(steps).toHaveLength(2);
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].text).toContain('install the dependency');
    expect(steps[0].text).toContain('npm install @sap/xsuaa');
    expect(steps[1].stepNumber).toBe(2);
    expect(steps[1].text).toContain('Bind the service via mta.yaml');
  });

  it('extracts steps from v2 H3/section format', () => {
    const steps = extractStepText(fixture('v2-h3.html'));
    expect(steps).toHaveLength(2);
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].text).toContain('Install the dependency');
    expect(steps[1].text).toContain('Bind the service');
  });

  it('normalises whitespace (collapses runs to single space, trims)', () => {
    const html = '<section data-step="1"><p>a   b\n\n  c</p></section>';
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps[0].text).toBe('a b c');
  });

  it('truncates oversized chunks at sentence boundary', () => {
    const sentence = 'This is a sentence. ';
    const big = sentence.repeat(1000); // ~20000 chars
    const html = `<section data-step="1"><p>${big}</p></section>`;
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps[0].text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // truncation MUST end on a sentence boundary, not mid-sentence
    expect(steps[0].text).toMatch(/\.\s*$/);
    expect(steps[0].charCount).toBe(steps[0].text.length);
  });

  it('returns [] and does not throw on malformed HTML', () => {
    const steps = extractStepText(gzipSync(Buffer.from('<not really html')));
    expect(steps).toEqual([]);
  });

  it('returns [] when no step markers present', () => {
    const html = '<html><body><p>no steps here</p></body></html>';
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps).toEqual([]);
  });
});
