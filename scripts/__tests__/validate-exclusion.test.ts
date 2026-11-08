import { describe, it, expect } from 'vitest';
import { slugFromFile, shortcodeBalanceCheck } from '../validate-tutorials.js';

describe('slugFromFile', () => {
  it('derives lowercased slug from a .md filename', () => {
    expect(slugFromFile('Connect-GCP.md')).toBe('connect-gcp');
  });
});

describe('shortcodeBalanceCheck', () => {
  // Regression: self-closing inline directive shortcodes ({{< tut-ui >}} etc.)
  // have no close tag by design and must NOT be counted as "opens". Counting
  // them falsely quarantined directive-ui-instructions ("11 opens, 0 closes"),
  // so its directives never reached the published HTML.
  it('does not quarantine self-closing inline tut-* shortcodes', () => {
    const body = '{{< tut-ui label="Save" >}} {{< tut-menu label="A > B" >}} ' +
      '{{< tut-kbd label="Mod+S" >}} {{< tut-icon label="x" >}} {{< tut-ask prompt="y" >}}';
    expect(shortcodeBalanceCheck(body)).toBeNull();
  });

  it('still passes a balanced paired os-panel block', () => {
    expect(shortcodeBalanceCheck('{{< os-panel os="win" >}}\nx\n{{< /os-panel >}}')).toBeNull();
  });

  it('still quarantines a genuinely unclosed paired shortcode', () => {
    expect(shortcodeBalanceCheck('{{< os-panel os="win" >}}\nno close')).toMatch(/unclosed/i);
  });

  it('handles inline tut-* mixed with a balanced os-panel pair', () => {
    const body = '{{< tut-ui label="Go" >}}\n{{< os-panel os="win" >}}\nx\n{{< /os-panel >}}';
    expect(shortcodeBalanceCheck(body)).toBeNull();
  });
});
