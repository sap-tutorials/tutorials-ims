import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const partialPath = join(__dirname, '../../hugo/layouts/partials/consent.html');
const partial = readFileSync(partialPath, 'utf8');

/**
 * #1796: on a cookieless first visit the TrustArc blackbar paints in normal
 * flow and then collapses, reflowing article.developer-homepage (homepage
 * CLS ≈ 1.014). The fix pins #consent_blackbar as a position:fixed overlay so
 * its insertion/collapse can never shift in-flow content. These guards keep
 * that CSS from silently regressing (e.g. a future edit dropping the <style>).
 */
describe('#1796 consent blackbar overlay (CLS fix)', () => {
  // Extract the inline <style> block(s) from the partial for targeted asserts.
  const styleBlocks = (partial.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');

  it('renders an inline <style> block scoped to #consent_blackbar', () => {
    expect(styleBlocks).toMatch(/#consent_blackbar\s*\{/);
  });

  it('takes #consent_blackbar out of document flow via position: fixed', () => {
    // Isolate the #consent_blackbar rule body and assert position:fixed inside it.
    const rule = styleBlocks.match(/#consent_blackbar\s*\{([\s\S]*?)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/position:\s*fixed/);
  });

  it('pins the overlay to the bottom edge (bottom: 0)', () => {
    const rule = styleBlocks.match(/#consent_blackbar\s*\{([\s\S]*?)\}/);
    expect(rule[1]).toMatch(/bottom:\s*0/);
  });

  it('layers the overlay above site chrome (z-index > 9999)', () => {
    const rule = styleBlocks.match(/#consent_blackbar\s*\{([\s\S]*?)\}/);
    const z = rule[1].match(/z-index:\s*(\d+)/);
    expect(z).not.toBeNull();
    expect(Number(z[1])).toBeGreaterThan(9999);
  });

  it('still renders the #consent_blackbar div that TrustArc fills', () => {
    expect(partial).toMatch(/<div id="consent_blackbar"><\/div>/);
  });

  it('emits the overlay only in the trustarc CMP branch', () => {
    // The <style> and div must live after the `eq $cmp "trustarc"` guard and
    // before the inhouse branch, so cmp=off / cmp=inhouse never emit them.
    const trustarcIdx = partial.indexOf('eq $cmp "trustarc"');
    const inhouseIdx = partial.indexOf('eq $cmp "inhouse"');
    const styleIdx = partial.indexOf('#consent_blackbar {');
    expect(trustarcIdx).toBeGreaterThanOrEqual(0);
    expect(inhouseIdx).toBeGreaterThan(trustarcIdx);
    expect(styleIdx).toBeGreaterThan(trustarcIdx);
    expect(styleIdx).toBeLessThan(inhouseIdx);
  });
});
