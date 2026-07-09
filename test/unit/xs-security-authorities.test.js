// Phase A1 (#809) — Regression guard. The top-level `authorities` array in
// xs-security.json is auto-granted to every authenticated JWT. Prior to A1
// it contained `$XSAPPNAME.Tutorial.Author`, which defeated the `Tutorials
// Author` role-collection design (any authenticated user got QA-preview
// access). This test locks the auto-grant down to `Everyone` only.
//
// Two files must stay in sync: the root `xs-security.json` (used by
// `cds watch` locally) and `.deploy/xs-security.json` (the one MTA actually
// deploys via `.deploy/mta.yaml`'s `config-path: xs-security.json`). The
// original A1 fix (PR #941) only updated the root file; the drift was
// discovered post-cutover on 2026-07-03 when it turned out the deploy copy
// still had the auto-grant. This test now covers BOTH files so any future
// drift fails CI.
//
// If a future change must re-add a scope here, update this test AND
// document the operational impact in xsuaa-role-collection-assignment.md.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const FILES = [
  'xs-security.json',
  '.deploy/xs-security.json',
];

describe.each(FILES)('%s — top-level authorities auto-grant', (relPath) => {
  const cfg = JSON.parse(
    readFileSync(join(process.cwd(), relPath), 'utf8')
  );

  it('exposes an authorities array', () => {
    expect(Array.isArray(cfg.authorities)).toBe(true);
  });

  it('auto-grants ONLY $XSAPPNAME.Everyone (no other scopes)', () => {
    expect(cfg.authorities).toEqual(['$XSAPPNAME.Everyone']);
  });

  it('does not auto-grant Tutorial.Author (A1 regression)', () => {
    expect(cfg.authorities).not.toContain('$XSAPPNAME.Tutorial.Author');
  });
});

describe('xs-security.json root vs .deploy copy — drift guard', () => {
  const root = readFileSync(join(process.cwd(), 'xs-security.json'), 'utf8');
  const deploy = readFileSync(join(process.cwd(), '.deploy/xs-security.json'), 'utf8');

  it('root and .deploy copies are byte-identical', () => {
    // The two files are duplicated by convention: cds watch reads the root,
    // MTA deploy reads the .deploy copy. Any drift between them creates a
    // gap between local behavior and deployed behavior. This assertion
    // caught the Phase A1 partial-fix on 2026-07-03 (root had the auto-grant
    // removed but the deploy copy still had it, so the next MTA deploy
    // would have regressed the fix silently).
    expect(deploy).toBe(root);
  });
});

describe('Tutorial.API scope (#996)', () => {
  it('is declared in both xs-security.json files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const cfg = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const names = (cfg.scopes || []).map(s => s.name);
      expect(names).toContain('$XSAPPNAME.Tutorial.API');
    }
  });

  it('has a role template TutorialApiConsumer in both files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const cfg = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const names = (cfg['role-templates'] || []).map(r => r.name);
      expect(names).toContain('TutorialApiConsumer');
    }
  });
});

describe('Tutorial.MCP scope (#1105)', () => {
  it('declares Tutorial.MCP scope in both xs-security files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const content = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const names = content.scopes.map(s => s.name);
      expect(names).toContain('$XSAPPNAME.Tutorial.MCP');
    }
  });

  it('declares TutorialMCP role template in both xs-security files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const content = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const tpl = content['role-templates'].find(t => t.name === 'TutorialMCP');
      expect(tpl).toBeDefined();
      expect(tpl['scope-references']).toContain('$XSAPPNAME.Tutorial.MCP');
      expect(tpl['scope-references']).toContain('$XSAPPNAME.Everyone');
    }
  });

  it('declares "Tutorials MCP Users" role collection in both xs-security files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const content = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const rc = content['role-collections'].find(r => r.name === 'Tutorials MCP Users');
      expect(rc).toBeDefined();
      expect(rc['role-template-references']).toContain('$XSAPPNAME.TutorialMCP');
    }
  });

  it('oauth2-configuration.redirect-uris includes MCP client callback patterns in both xs-security files', () => {
    for (const path of ['xs-security.json', '.deploy/xs-security.json']) {
      const content = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
      const uris = content['oauth2-configuration']?.['redirect-uris'] ?? [];
      // RFC 8252 §7.3 — loopback with port-wildcard + fixed callback path.
      // Custom-scheme wildcards (mcp://*) and unbounded-port loopbacks
      // (http://localhost/*) are OAuth open-redirect hazards; the security
      // review pass caught them and the plan was patched.
      for (const required of [
        'http://127.0.0.1:*/callback',
        'http://localhost:*/callback',
        'https://developers.sap.com/callback'
      ]) {
        expect(uris).toContain(required);
      }
      // Anti-regression: the hazardous patterns must NOT reappear.
      for (const hazardous of [
        'http://localhost/*',
        'http://127.0.0.1/*',
        'mcp://*'
      ]) {
        expect(uris).not.toContain(hazardous);
      }
    }
  });
});
