// test/unit/check-ui5-entry-coverage.test.ts
import { describe, it, expect } from 'vitest';
import { extractDefinedTags } from '../../scripts/check-ui5-entry-coverage.ts';

describe('extractDefinedTags', () => {
  it('reads the actual tag from customElements.define, incl. irregular tags', () => {
    const bundle = `customElements.define("ui5-shellbar",X);customElements.define('ui5-li',Y);`;
    const tags = extractDefinedTags(bundle);
    expect(tags.has('ui5-shellbar')).toBe(true);   // NOT ui5-shell-bar
    expect(tags.has('ui5-li')).toBe(true);          // ListItemStandard
  });
  it('ignores non-ui5 defines', () => {
    expect(extractDefinedTags(`customElements.define("my-widget",Z)`).has('my-widget')).toBe(false);
  });
  it('reads {tag:"ui5-xxx"} object-decorator form (Pattern 2, minified)', () => {
    // Dominant pattern in Vite-minified UI5 bundles: W([z({tag:"ui5-shellbar",...})])
    expect(extractDefinedTags(`{tag:"ui5-shellbar",x:1}`).has('ui5-shellbar')).toBe(true);
  });
  it('reads positional string-decorator form (Pattern 3, minified)', () => {
    // Pattern seen for WizardStep: me([z("ui5-wizard-step")],se) → "ui5-wizard-step")]
    expect(extractDefinedTags(`[z("ui5-wizard-step")]`).has('ui5-wizard-step')).toBe(true);
  });
});
