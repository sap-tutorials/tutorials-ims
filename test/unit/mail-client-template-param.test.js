import { describe, it, expect } from 'vitest';
import { loadTemplate } from '../../srv/lib/mail-client.js';

describe('loadTemplate — accepts numeric level or base name', () => {
  it('numeric level still works (legacy path)', () => {
    expect(loadTemplate(0)).toMatch(/first reminder/i);
    expect(loadTemplate(3)).toMatch(/deadline for reviewing/i);
  });

  it('base name string reads the matching .html file', () => {
    expect(loadTemplate('first')).toMatch(/first reminder/i);
    expect(loadTemplate('final')).toMatch(/deadline for reviewing/i);
  });

  it('unknown base name throws', () => {
    expect(() => loadTemplate('no-such-template')).toThrow();
  });

  it('rejects base names with path separators or ".." (defense-in-depth)', () => {
    expect(() => loadTemplate('../etc/passwd')).toThrow();
    expect(() => loadTemplate('foo/bar')).toThrow();
    expect(() => loadTemplate('foo\\bar')).toThrow();
  });
});
