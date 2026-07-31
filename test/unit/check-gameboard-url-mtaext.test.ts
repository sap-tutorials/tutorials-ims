import { describe, it, expect } from 'vitest';
import { readGameboardUrl, effectiveUrl } from '../../scripts/check-gameboard-url-mtaext.ts';

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
});
