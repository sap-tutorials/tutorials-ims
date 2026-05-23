import { describe, it, expect } from 'vitest';
import { parseChannel, getQaCacheDir, getHugoContentDir } from '../fetch-tutorials';

describe('fetch-tutorials qa channel', () => {
  it('parses --channel qa', () => {
    expect(parseChannel(['node', 'x', '--channel', 'qa'])).toBe('qa');
  });
  it('defaults to prod', () => {
    expect(parseChannel(['node', 'x'])).toBe('prod');
  });
  it('returns separate cache dir for qa', () => {
    expect(getQaCacheDir('qa')).toMatch(/\.tutorial-cache-qa$/);
    expect(getQaCacheDir('prod')).toMatch(/\.tutorial-cache$/);
  });
  it('returns separate Hugo content dir for qa (no shared writes to prod content/)', () => {
    expect(getHugoContentDir('qa')).toMatch(/hugo[\\/]content-qa$/);
    expect(getHugoContentDir('prod')).toMatch(/hugo[\\/]content$/);
  });
});
