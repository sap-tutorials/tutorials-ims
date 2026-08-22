// test/unit/freshness-prompt-guard.test.js
// Task 5: Asserts the FRESHNESS_TOOL_SPEC JSON-schema shape is correct.
// Confidence enum and groundingSource must be present on every finding item.

import { describe, it, expect } from 'vitest';
import { FRESHNESS_TOOL_SPEC } from '../../srv/lib/freshness-detector.js';

describe('FRESHNESS_TOOL_SPEC', () => {
  it('requires confidence and groundingSource on every finding', () => {
    const item = FRESHNESS_TOOL_SPEC.function.parameters.properties.findings.items;
    expect(item.required).toEqual(expect.arrayContaining(['confidence', 'groundingSource', 'category', 'severity', 'stepRef', 'codeBlockIndex']));
    expect(item.properties.confidence.enum).toEqual(['High', 'Medium', 'Low']);
  });
});
