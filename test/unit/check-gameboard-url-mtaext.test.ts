import { describe, it, expect } from 'vitest';
import { readGameboardUrl, readParam, effectiveUrl } from '../../scripts/check-gameboard-url-mtaext.ts';

describe('check-gameboard-url-mtaext parser', () => {
  const base = [
    '_schema-version: 3.3.0',
    'ID: tutorials-ims',
    'version: 1.7.1',
    'parameters:',
    '  gameboard-url: UNSET-see-env-mtaext',
    'modules:',
    '  - name: tutorials-approuter',
  ].join('\n');

  it('reads the base placeholder', () => {
    expect(readGameboardUrl(base)).toBe('UNSET-see-env-mtaext');
  });

  it('returns null when no parameters block / key present', () => {
    expect(readGameboardUrl('ID: x\nmodules:\n  - name: a')).toBeNull();
  });

  it('does not read a gameboard-url that lives outside the parameters block', () => {
    const text = [
      'ID: x',
      'modules:',
      '  - name: m',
      '    properties:',
      '      gameboard-url: https://sneaky',   // not under top-level parameters:
    ].join('\n');
    expect(readGameboardUrl(text)).toBeNull();
  });

  it('effectiveUrl: mtaext override wins over base placeholder', () => {
    const ext = [
      'ID: tutorials-ims-dev',
      'extends: tutorials-ims',
      'parameters:',
      '  gameboard-url: https://dev-host.example',
      'modules:',
    ].join('\n');
    expect(effectiveUrl(base, ext)).toBe('https://dev-host.example');
  });

  it('effectiveUrl: falls back to base placeholder when mtaext has no override', () => {
    const ext = 'ID: tutorials-ims-qa\nextends: tutorials-ims\nmodules:\n  - name: x';
    expect(effectiveUrl(base, ext)).toBe('UNSET-see-env-mtaext');
  });

  it('readParam: reads an arbitrary guarded param (srv-mcp-url)', () => {
    const text = [
      'parameters:',
      '  gameboard-url: https://gb.example',
      '  srv-mcp-url: https://mcp.example',
      'modules:',
      '  - name: x',
    ].join('\n');
    expect(readParam(text, 'srv-mcp-url')).toBe('https://mcp.example');
    expect(readParam(text, 'gameboard-url')).toBe('https://gb.example');
    expect(readParam(text, 'missing-url')).toBeNull();
  });

  it('effectiveUrl: resolves srv-mcp-url via override, else base placeholder', () => {
    const baseMcp = 'parameters:\n  srv-mcp-url: UNSET-see-env-mtaext\nmodules:\n  - name: x';
    const ext = 'extends: tutorials-ims\nparameters:\n  srv-mcp-url: https://prod-mcp.example\nmodules:\n  - name: x';
    expect(effectiveUrl(baseMcp, ext, 'srv-mcp-url')).toBe('https://prod-mcp.example');
    expect(effectiveUrl(baseMcp, 'modules:\n  - name: x', 'srv-mcp-url')).toBe('UNSET-see-env-mtaext');
  });
});
