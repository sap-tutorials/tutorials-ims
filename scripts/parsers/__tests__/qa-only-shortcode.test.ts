import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composeTutorial } from '../compose.js';
import { resetRegistry, registerDirective } from '../directive-registry.js';
import { qaOnlyDef } from '../directives/qa-only.js';

beforeEach(() => {
  resetRegistry();
  registerDirective(qaOnlyDef);
});
afterEach(() => {
  resetRegistry();
});

function makeFm() {
  return '---\nparser: v2\ntitle: T\ntime: 5\ntags: [tutorial>beginner]\nprimary_tag: tutorial>beginner\nauthor_name: A\nauthor_profile: https://example.com\n---\n\n';
}

const BASE = { repo: 'r', branch: 'b', slug: 's', target: 'hugo' as const, rewriteImages: false };

it('QA channel emits tut-qa-only shortcode for qa-only block', () => {
  const md = makeFm() + '# T\n\n### Step 1\n\n:::qa-only[My reason]\ncontent\n:::\n';
  const { body } = composeTutorial(md, { ...BASE, channel: 'qa' });
  expect(body).toContain('tut-qa-only');
  expect(body).toContain('My reason');
});

it('PROD channel emits nothing for qa-only block', () => {
  const md = makeFm() + '# T\n\n### Step 1\n\n:::qa-only[My reason]\ncontent\n:::\n';
  const { body } = composeTutorial(md, { ...BASE, channel: 'prod' });
  expect(body).not.toContain('tut-qa-only');
  expect(body).not.toContain('My reason');
  expect(body).not.toContain('content');
});
