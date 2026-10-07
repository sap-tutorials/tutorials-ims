import { describe, it, expect } from 'vitest';
import { slugFromFile } from '../validate-tutorials.js';

describe('slugFromFile', () => {
  it('derives lowercased slug from a .md filename', () => {
    expect(slugFromFile('Connect-GCP.md')).toBe('connect-gcp');
  });
});
