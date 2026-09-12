import { describe, it, expect } from 'vitest';
import { buildVerifyScript, shquote, buildSkillMd } from '../../srv/lib/skill-bundle.js';

describe('shquote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shquote(`a'b`)).toBe(`'a'\\''b'`);
    expect(shquote('cds compile')).toBe(`'cds compile'`);
  });

  it('preserves dollar signs and backticks inside single quotes so they cannot execute at runtime', () => {
    // a'b$(x)`y  →  'a'\''b$(x)`y'
    // The $ and ` land inside single-quoted segments and are shell-inert
    expect(shquote("a'b$(x)`y")).toBe("'a'\\''b$(x)`y'");
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
    expect(s).toContain("-X 'GET'");
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

  it('shell-quotes curl -X method to prevent shell injection via a hostile method value', () => {
    const s = buildVerifyScript([{ stepNumber: 1, assertIndex: 0, type: 'http', method: "GET;rm -rf ~ #", path: '/x', expectStatus: 200 }]);
    // The injected semicolon must be inside single quotes so it cannot start a new command
    expect(s).toContain("-X 'GET;rm -rf ~ #'");
    // An unquoted -X GET; sequence that would let rm run must NOT appear
    expect(s).not.toMatch(/-X GET;/);
  });

  it('shell-quotes the echo label to prevent command substitution via type or step metadata', () => {
    const s = buildVerifyScript([{ stepNumber: 1, assertIndex: 0, type: 'cmd$(evil)', run: 'true', expectExit: 0 }]);
    // The label must appear as a single-quoted string, not a double-quoted one that would expand $()
    expect(s).toContain("echo 'Running check for cmd$(evil) @ step 1.0'");
    // The per-assert echo must NOT use a double-quoted string (which would live-expand $(evil))
    expect(s).not.toContain('echo "Running check for');
  });
});

const SRC = `---\ntitle: Create a CAP Service\ndescription: Build and run a CAP service.\n---\n\n## Step 1\nDo the thing.\n`;

describe('buildSkillMd', () => {
  it('emits YAML frontmatter with name (slug) and description (from source)', () => {
    const md = buildSkillMd({ slug: 'create-cap-service', source: SRC, asserts: [], stamp: { confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc123', jws: null } });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('name: create-cap-service');
    expect(md).toContain('Create a CAP Service'); // description carried from source title/description
  });

  it('includes the procedure body (source minus frontmatter)', () => {
    const md = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null } });
    expect(md).toContain('Do the thing.');
    expect(md).not.toContain('title: Create a CAP Service'); // frontmatter not duplicated into body
  });

  it('provenance section reflects the stamp and states check count', () => {
    const md = buildSkillMd({ slug: 's', source: SRC, asserts: [{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'x', expectExit: 0 }], stamp: { confidence: 'medium', lastVerified: '2026-08-01', sourceCommit: 'deadbeef', jws: null } });
    expect(md).toContain('confidence: medium');
    expect(md).toContain('2026-08-01');
    expect(md).toContain('deadbeef');
    expect(md).toContain('1'); // one bundled check
  });

  it('includes the JWS fenced block only when present', () => {
    const withJws = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc', jws: 'eyJ.sig' } });
    expect(withJws).toContain('eyJ.sig');
    const without = buildSkillMd({ slug: 's', source: SRC, asserts: [], stamp: { confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null } });
    expect(without).not.toContain('```jws');
  });
});
