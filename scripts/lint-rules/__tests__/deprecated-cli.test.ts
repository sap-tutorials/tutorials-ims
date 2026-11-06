import { describe, it, expect } from 'vitest';
import { deprecatedCliRule } from '../deprecated-cli.js';

describe('deprecatedCliRule', () => {
  it('flags a deprecated --hostname flag in a bash fence', () => {
    const rawLines = ['```bash', '$ cf push myapp --hostname myhost', '```'];
    const findings = deprecatedCliRule.scan('test', [], rawLines);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].rule).toBe('deprecated-cli');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('--hostname');
    expect(findings[0].message).toContain('http');  // docs URL present
  });

  it('does NOT flag a JavaScript fence containing cf push --hostname', () => {
    const rawLines = ['```javascript', "const cmd = 'cf push myapp --hostname myhost';", '```'];
    expect(deprecatedCliRule.scan('test', [], rawLines)).toHaveLength(0);
  });

  it('does NOT flag a bash fence with no matching commands', () => {
    const rawLines = ['```bash', 'cf push myapp', '```'];
    expect(deprecatedCliRule.scan('test', [], rawLines)).toHaveLength(0);
  });

  it('strips $ prompt before matching', () => {
    const rawLines = ['```console', '$ cf push app --hostname h', '```'];
    const findings = deprecatedCliRule.scan('test', [], rawLines);
    expect(findings.length).toBeGreaterThan(0);
  });
});
