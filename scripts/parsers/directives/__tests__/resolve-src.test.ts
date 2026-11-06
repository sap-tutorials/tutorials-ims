// scripts/parsers/directives/__tests__/resolve-src.test.ts
import { describe, it, expect } from 'vitest';
import { resolveSrc } from '../resolve-src.js';

const REPO = 'my-tutorials';
const BRANCH = 'main';
const SLUG = 'my-tutorial';

it('returns absolute URLs unchanged', () => {
  expect(resolveSrc('https://example.com/img.png', REPO, BRANCH, SLUG))
    .toBe('https://example.com/img.png');
});

it('resolves relative src to raw GitHub URL', () => {
  expect(resolveSrc('diagram.svg', REPO, BRANCH, SLUG))
    .toBe('https://raw.githubusercontent.com/sap-tutorials/my-tutorials/main/tutorials/my-tutorial/diagram.svg');
});

it('strips leading ./ from relative src', () => {
  expect(resolveSrc('./arch.drawio.svg', REPO, BRANCH, SLUG))
    .toBe('https://raw.githubusercontent.com/sap-tutorials/my-tutorials/main/tutorials/my-tutorial/arch.drawio.svg');
});
