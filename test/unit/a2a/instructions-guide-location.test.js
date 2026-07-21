import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the #1220 deploy regression: the /.well-known/a2a-instructions.md
// handler in srv/server.js reads the guide from srv/mcp/ (a location packaged
// into the deployed CAP module by `cds build`), NOT from docs/ (which is not
// deployed → 404 in CF). If someone moves the guide back under docs/ or renames
// it, this fails before it ships. Path is resolved the SAME way the handler does
// (relative to srv/), so the test and the handler cannot drift.
describe('A2A consumption guide is served from a deployed srv/ location', () => {
  // srv/server.js resolves `new URL('./mcp/a2a-instructions.md', import.meta.url)`.
  // This test file is at test/unit/a2a/, so resolve to the repo srv/ explicitly.
  const guidePath = fileURLToPath(new URL('../../../srv/mcp/a2a-instructions.md', import.meta.url));

  it('exists at srv/mcp/a2a-instructions.md', () => {
    expect(existsSync(guidePath), `expected the A2A guide at ${guidePath}`).toBe(true);
  });

  it('is the consumption guide (not an empty/placeholder file)', () => {
    const body = readFileSync(guidePath, 'utf8');
    expect(body).toContain('A2A Agent — Consumption Guide');
    expect(body).toMatch(/\/\.well-known\/agent-card\.json/);
    expect(body.length).toBeGreaterThan(500);
  });
});
