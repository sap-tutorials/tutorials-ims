import { describe, it, expect } from 'vitest';
import { resolveImageURLs } from '../../scripts/parsers/images.js';

describe('resolveImageURLs', () => {
  const opts = { repo: 'r', branch: 'b', slug: 's' };

  it('rewrites by default', () => {
    expect(resolveImageURLs('![a](./images/x.png)', opts))
      .toContain('raw.githubusercontent.com/sap-tutorials/r/b/tutorials/s/images/x.png');
  });

  it('passes images through when rewriteImages: false', () => {
    const out = resolveImageURLs('![a](./images/x.png)', { ...opts, rewriteImages: false });
    expect(out).toContain('./images/x.png');
    expect(out).not.toContain('raw.githubusercontent.com');
  });

  it('still strips border/size HTML comments when rewriteImages: false', () => {
    const out = resolveImageURLs('<!-- border -->![a](./images/x.png)', { ...opts, rewriteImages: false });
    expect(out).not.toContain('border');
    expect(out).toContain('![a](./images/x.png)');
  });

  it('leaves absolute URLs untouched in either mode', () => {
    expect(resolveImageURLs('![a](https://x.com/y.png)', opts))
      .toContain('https://x.com/y.png');
    expect(resolveImageURLs('![a](https://x.com/y.png)', { ...opts, rewriteImages: false }))
      .toContain('https://x.com/y.png');
  });
});
