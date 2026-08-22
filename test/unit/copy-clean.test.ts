import { describe, it, expect } from 'vitest';
import { stripPrompts } from '../../hugo/assets/js/copy-clean';

describe('stripPrompts', () => {
  it('strips a single leading $ prompt', () => {
    expect(stripPrompts('$ npm install')).toBe('npm install');
  });
  it('strips per line across a block', () => {
    expect(stripPrompts('$ cd app\n$ npm run build')).toBe('cd app\nnpm run build');
  });
  it('strips >, #, and PS> prompts', () => {
    expect(stripPrompts('> node x.js')).toBe('node x.js');
    expect(stripPrompts('# apt update')).toBe('apt update');
    expect(stripPrompts('PS> Get-Item')).toBe('Get-Item');
    expect(stripPrompts('PS C:\\app> dir')).toBe('dir');
  });
  it('leaves mid-line $ and > untouched', () => {
    expect(stripPrompts('echo $HOME > out.txt')).toBe('echo $HOME > out.txt');
  });
  it('leaves lines without a prompt untouched (incl. indentation)', () => {
    expect(stripPrompts('  const x = 1;')).toBe('  const x = 1;');
  });
  it('is a no-op on empty string', () => {
    expect(stripPrompts('')).toBe('');
  });
});
