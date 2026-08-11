import { describe, it, expect } from 'vitest';
import { mergeProgress, emptyWhiteCells } from '../lib/progress';

describe('mergeProgress', () => {
  it('migrates local when the server grid is empty or null (changed=true)', () => {
    expect(mergeProgress('{}', { '0,0': 'C' })).toEqual({ merged: { '0,0': 'C' }, changed: true });
    expect(mergeProgress(null, { '0,0': 'C' })).toEqual({ merged: { '0,0': 'C' }, changed: true });
  });

  it('preserves local-only answers on top of the server grid (issue #1650 bug 1)', () => {
    // Server has the old answers; local was filled anonymously with an extra word.
    const server = '{"0,0":"C","0,1":"A"}';
    const local = { '0,0': 'C', '0,1': 'A', '2,0': 'O', '2,1': 'D', '2,2': 'B', '2,3': 'C' };
    const { merged, changed } = mergeProgress(server, local);
    expect(merged).toEqual({ '0,0': 'C', '0,1': 'A', '2,0': 'O', '2,1': 'D', '2,2': 'B', '2,3': 'C' });
    expect(changed).toBe(true); // local contributed cells the server lacked → persist back
  });

  it('lets the server win for conflicting cells but still adds local-only cells', () => {
    const server = '{"0,0":"C"}';
    const local = { '0,0': 'X', '0,1': 'A' }; // 0,0 conflicts; 0,1 is local-only
    const { merged, changed } = mergeProgress(server, local);
    expect(merged).toEqual({ '0,0': 'C', '0,1': 'A' });
    expect(changed).toBe(true);
  });

  it('is a no-op when local adds nothing (server wins, changed=false)', () => {
    expect(mergeProgress('{"0,0":"C"}', {})).toEqual({ merged: { '0,0': 'C' }, changed: false });
    expect(mergeProgress('{"0,0":"C"}', { '0,0': 'C' })).toEqual({ merged: { '0,0': 'C' }, changed: false });
    expect(mergeProgress('{}', {})).toEqual({ merged: {}, changed: false });
  });

  it('drops empty-string cells from both sides', () => {
    const { merged, changed } = mergeProgress('{"0,0":"C","0,1":""}', { '0,2': '', '0,3': 'D' });
    expect(merged).toEqual({ '0,0': 'C', '0,3': 'D' });
    expect(changed).toBe(true);
  });

  it('tolerates corrupt server JSON by treating it as empty', () => {
    expect(mergeProgress('not json', { '0,0': 'C' })).toEqual({ merged: { '0,0': 'C' }, changed: true });
  });
});

describe('emptyWhiteCells', () => {
  it('returns non-black cells lacking a letter', () => {
    const grid = [[{black:false},{black:true},{black:false}]] as any;
    const answers = { '0,0':'C' }; // 0,2 empty, 0,1 black
    expect(emptyWhiteCells(grid, answers)).toEqual([{ r:0, c:2 }]);
  });
});
