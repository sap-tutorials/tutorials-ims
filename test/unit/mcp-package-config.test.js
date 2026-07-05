import { expect, describe, it } from 'vitest';
import fs from 'node:fs';

describe('MCP package.json configuration', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  it('pins @cap-js/ai to ~1.0 (patch-only updates)', () => {
    expect(pkg.dependencies['@cap-js/ai']).toMatch(/^~1\.0/);
  });

  it('configures MCP protocol path', () => {
    expect(pkg.cds?.requires?.ai?.mcp?.path).toBe('/mcp');
  });
});
