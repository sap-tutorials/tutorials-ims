import { describe, it, expect } from 'vitest';

// We intentionally import the file (not run cds.test) — the tool list test
// follows in a later task, this one only verifies the exported constant shape.
import * as orchestrator from '../srv/lib/chat-orchestrator.js';

describe('GET_DEVTOBERFEST_INFO_TOOL definition', () => {
  it('exports a JSON-schema function tool with the expected shape', () => {
    const tool = orchestrator.GET_DEVTOBERFEST_INFO_TOOL;
    expect(tool).toBeDefined();
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('getDevtoberfestInfo');
    expect(typeof tool.function.description).toBe('string');
    expect(tool.function.description.length).toBeGreaterThan(40);

    const params = tool.function.parameters;
    expect(params.type).toBe('object');
    expect(params.properties.section.type).toBe('string');
    expect(params.properties.section.enum).toEqual([
      'all', 'event', 'terms', 'links', 'points', 'gameboard', 'activities', 'videos'
    ]);
    // Section is optional — handler defaults to 'all'.
    expect(params.required).toBeUndefined();
  });
});
