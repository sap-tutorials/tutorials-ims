import { describe, it, expect } from 'vitest';
import { shouldMigrate, emptyWhiteCells } from '../lib/progress';

describe('shouldMigrate', () => {
  it('migrates when authed + empty server + non-empty local', () => {
    expect(shouldMigrate(true, '{}', { '0,0':'C' })).toBe(true);
    expect(shouldMigrate(true, null, { '0,0':'C' })).toBe(true);
  });
  it('does not migrate when server has data, or local empty, or anon', () => {
    expect(shouldMigrate(true, '{"0,0":"C"}', { '0,1':'A' })).toBe(false);
    expect(shouldMigrate(true, '{}', {})).toBe(false);
    expect(shouldMigrate(false, '{}', { '0,0':'C' })).toBe(false);
  });
});

describe('emptyWhiteCells', () => {
  it('returns non-black cells lacking a letter', () => {
    const grid = [[{black:false},{black:true},{black:false}]] as any;
    const answers = { '0,0':'C' }; // 0,2 empty, 0,1 black
    expect(emptyWhiteCells(grid, answers)).toEqual([{ r:0, c:2 }]);
  });
});
