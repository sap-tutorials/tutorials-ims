// test/unit/mcp-prompt-loader.test.js
import { expect, describe, it, beforeAll } from 'vitest';
import path from 'node:path';
import { loadPrompts, listPrompts, getPrompt } from '../../srv/lib/mcp-prompt-loader.js';

const PROMPT_DIR = path.join(process.cwd(), 'srv/mcp/prompts');

describe('mcp-prompt-loader', () => {
  let prompts;
  beforeAll(() => { prompts = loadPrompts(PROMPT_DIR); });

  it('loads at least 4 prompts with required frontmatter', () => {
    expect(prompts.size).toBeGreaterThanOrEqual(4);
    for (const p of prompts.values()) {
      expect(p.name).toMatch(/^[a-z_]+$/);
      expect(p.description.length).toBeGreaterThanOrEqual(20);
      expect(Array.isArray(p.arguments)).toBe(true);
      expect(p.template.length).toBeGreaterThan(0);
    }
  });

  it('prompts/list returns name+description+arguments for each', () => {
    const list = listPrompts(prompts);
    expect(list.length).toBe(prompts.size);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName.summarize_mission_for_beginner).toBeDefined();
    expect(byName.summarize_mission_for_beginner.arguments[0].name).toBe('mission_slug');
  });

  it('prompts/get interpolates {{arg}} and returns a user message', () => {
    const res = getPrompt(prompts, 'summarize_mission_for_beginner', { mission_slug: 'cap-intro' });
    expect(res.messages[0].role).toBe('user');
    expect(res.messages[0].content.text).toContain('cap-intro');
    expect(res.messages[0].content.text).not.toContain('{{mission_slug}}');
  });

  it('prompts/get throws on unknown name', () => {
    expect(() => getPrompt(prompts, 'nope', {})).toThrow(/unknown prompt/i);
  });

  it('prompts/get throws when a required arg is missing', () => {
    expect(() => getPrompt(prompts, 'summarize_mission_for_beginner', {})).toThrow(/required/i);
  });

  it('loadPrompts throws on malformed frontmatter', () => {
    // point at a fixture dir with a bad file
    const badDir = path.join(process.cwd(), 'test/fixtures/bad-prompts');
    expect(() => loadPrompts(badDir)).toThrow();
  });
});
