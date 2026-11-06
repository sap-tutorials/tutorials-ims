import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composeTutorial } from '../compose.js';
import { resetRegistry, registerDirective } from '../directive-registry.js';
import { qaOnlyDef } from '../directives/qa-only.js';

function makeFm(extra = ''): string {
  return ['---', 'parser: v2', 'title: T', 'time: 5',
    'tags: [tutorial>beginner]', 'primary_tag: tutorial>beginner',
    'author_name: A', 'author_profile: https://example.com',
    extra, '---', ''].filter(l => l !== '').join('\n') + '\n';
}

const BASE = { repo: 'r', branch: 'b', slug: 's', target: 'hugo' as const, rewriteImages: false };

beforeEach(() => {
  resetRegistry();
  registerDirective(qaOnlyDef);
});

afterEach(() => resetRegistry());

describe('author notes in compose', () => {
  it('strips author notes from PROD body and steps', () => {
    const md = makeFm() + '# T\n\n### Step 1\n\nHello %% @jdoe: fix me %% world.\n';
    const result = composeTutorial(md, { ...BASE, channel: 'prod' });
    expect(result.body).not.toContain('%%');
    expect(result.body).not.toContain('fix me');
    expect(result.steps[0].content).not.toContain('%%');
  });

  it('renders author notes on QA body', () => {
    const md = makeFm() + '# T\n\n### Step 1\n\nHello %% @jdoe: fix me %% world.\n';
    const result = composeTutorial(md, { ...BASE, channel: 'qa' });
    expect(result.body).toContain('tut-author-note');
    expect(result.body).toContain('fix me');
  });
});

describe('qa-only directive in compose', () => {
  it('removes qa-only block from PROD and does not affect step count', () => {
    const md = makeFm() + '# T\n\n### Step 1\n\nBefore.\n:::qa-only[Draft]\nDraft command.\n:::\nAfter.\n\n### Step 2\n\nDone.\n';
    const result = composeTutorial(md, { ...BASE, channel: 'prod' });
    expect(result.body).not.toContain('Draft command');
    expect(result.steps).toHaveLength(2);
  });

  it('renders qa-only block on QA', () => {
    const md = makeFm() + '# T\n\n### Step 1\n\nBefore.\n:::qa-only[Draft]\nDraft command.\n:::\nAfter.\n';
    const result = composeTutorial(md, { ...BASE, channel: 'qa' });
    expect(result.body).toContain('tut-qa-only');
  });

  it('fails the build when a step heading is inside qa-only', () => {
    const md = makeFm() + '# T\n\n### Step 1\n\n:::qa-only[Bad]\n### Extra step\n:::\n';
    expect(() => composeTutorial(md, { ...BASE, channel: 'qa' })).toThrow();
  });
});
