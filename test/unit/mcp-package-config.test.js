import { expect, describe, it } from 'vitest';
import fs from 'node:fs';

// The MCP protocol adapter is @cap-js/mcp (NOT @cap-js/ai — that's the AI Core
// mocks + Fiori ValueList recommendations plugin from #959). Reference:
// docs/developers/reference/cap-mcp-adapter-separate-package (memory-fact).
describe('MCP package.json configuration', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  it('depends on @cap-js/mcp at an exact 1.x version', () => {
    // Exact pin (project-wide save-exact = true). Allow any 1.x patch/minor —
    // the plugin is on a stable line and we bump deliberately.
    expect(pkg.dependencies['@cap-js/mcp']).toMatch(/^1\.\d+\.\d+$/);
  });

  it('turns on per-action tool exposure so each curated function is its own MCP tool', () => {
    // Without this flag, the adapter registers a single generic `call_action`
    // tool covering every action/function. The spec calls for eight named
    // tools (search_tutorials, get_tutorial, ...), so we opt in.
    expect(pkg.cds?.mcp?.per_action_tool).toBe(true);
  });
});
