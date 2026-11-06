import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderDirectivesAsText } from '../directives.js';
import { resetRegistry, registerDirective } from '../directive-registry.js';
import { qaOnlyDef } from '../directives/qa-only.js';

beforeEach(() => {
  resetRegistry();
  registerDirective(qaOnlyDef);
});

afterEach(() => {
  resetRegistry();
});

describe('renderDirectivesAsText — qa-only stripping', () => {
  it('strips qa-only block body from text output', () => {
    const md = 'Before.\n:::qa-only[Draft]\nDraft content here.\n:::\nAfter.';
    const result = renderDirectivesAsText(md);
    expect(result).not.toContain('Draft content here');
    expect(result).not.toContain('qa-only');
    expect(result).toContain('Before.');
    expect(result).toContain('After.');
  });

  it('returns plain text unchanged when no directives are present', () => {
    const md = 'Plain text only.';
    expect(renderDirectivesAsText(md)).toBe('Plain text only.');
  });
});
