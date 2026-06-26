import { describe, it, expect } from 'vitest';
import { selectEndpoint } from '../endpoint-select';

describe('selectEndpoint', () => {
  it('returns /api/alerts/me when authenticated', () => {
    expect(selectEndpoint(true)).toBe('/api/alerts/me');
  });
  it('returns /api/alerts when anonymous', () => {
    expect(selectEndpoint(false)).toBe('/api/alerts');
  });
});
