// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadPipMode, savePipMode, PIP_MODE_KEY } from './pip-storage';

beforeEach(() => {
  localStorage.clear();
});

describe('pip-storage', () => {
  it('returns "full" when no preference saved', () => {
    expect(loadPipMode()).toBe('full');
  });

  it('round-trips a saved mode', () => {
    savePipMode('controller');
    expect(loadPipMode()).toBe('controller');
  });

  it('uses the documented key', () => {
    savePipMode('controller');
    expect(localStorage.getItem(PIP_MODE_KEY)).toBe('controller');
  });

  it('returns "full" if the stored value is not a valid mode', () => {
    localStorage.setItem(PIP_MODE_KEY, 'garbage');
    expect(loadPipMode()).toBe('full');
  });
});
