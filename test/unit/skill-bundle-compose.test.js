import { describe, it, expect } from 'vitest';
import { buildVerifyScript, shquote } from '../../srv/lib/skill-bundle.js';

describe('shquote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shquote(`a'b`)).toBe(`'a'\\''b'`);
    expect(shquote('cds compile')).toBe(`'cds compile'`);
  });
});

describe('buildVerifyScript', () => {
  it('emits a bash header with strict mode', () => {
    const s = buildVerifyScript([]);
    expect(s.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(s).toContain('set -euo pipefail');
  });

  it('empty asserts → notice + exit 0', () => {
    const s = buildVerifyScript([]);
    expect(s).toContain('No automated checks defined');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('cmd assert runs the command and checks exit code + optional match', () => {
    const s = buildVerifyScript([{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'cds compile', expectExit: 0, match: 'ok' }]);
    expect(s).toContain(`'cds compile'`);
    expect(s).toContain('-eq 0');
    expect(s).toContain('grep -Eq');
  });

  it('http assert curls BASE_URL+path with method and checks status', () => {
    const s = buildVerifyScript([{ stepNumber: 2, assertIndex: 0, type: 'http', method: 'GET', path: '/foo', expectStatus: 200 }]);
    expect(s).toContain('BASE_URL="${BASE_URL:-http://localhost:4004}"');
    expect(s).toContain('-X GET');
    expect(s).toContain(shquote('/foo'));
    expect(s).toContain('200');
  });

  it('file exists vs contains', () => {
    const exists = buildVerifyScript([{ stepNumber: 3, assertIndex: 0, type: 'file', filePath: 'a.cds', expectContains: false }]);
    expect(exists).toContain('test -f');
    expect(exists).not.toContain('grep -Eq');
    const contains = buildVerifyScript([{ stepNumber: 3, assertIndex: 0, type: 'file', filePath: 'a.cds', expectContains: true, match: 'service' }]);
    expect(contains).toContain('grep -Eq');
  });

  it('preserves (stepNumber, assertIndex) order and fails overall when any check fails', () => {
    const s = buildVerifyScript([
      { stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'a', expectExit: 0 },
      { stepNumber: 1, assertIndex: 1, type: 'cmd', run: 'b', expectExit: 0 },
    ]);
    expect(s.indexOf("'a'")).toBeLessThan(s.indexOf("'b'"));
    expect(s).toContain('exit 1');
  });
});
