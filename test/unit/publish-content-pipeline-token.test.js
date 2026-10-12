/**
 * Tests for #2727 — the render-pipeline token forces a full re-publish when the
 * render pipeline (parsers / Hugo templates / CSS) changed, even though every
 * tutorial's per-slug rendered-HTML hash would need `hugo/public` to have been
 * rebuilt first. The token makes "a pipeline change invalidates all slugs"
 * explicit in the delta plan rather than relying solely on per-slug HTML diffs.
 *
 * `computePublishPlan` is the pure selector the CLI uses to pick target slugs.
 */
import { describe, it, expect } from 'vitest';
import { computePublishPlan } from '../../scripts/publish-content.ts';

describe('computePublishPlan — pipeline token (#2727)', () => {
  const local = new Map([
    ['a', 'hashA'],
    ['b', 'hashB'],
    ['c', 'hashC'],
  ]);

  it('delta mode: when the pipeline token matches, selects only HTML-diffed slugs', () => {
    const { targetSlugs } = computePublishPlan({
      local,
      remote: { a: 'hashA', b: 'DIFFERENT', c: 'hashC' },
      mode: 'delta',
      localToken: 'tok1',
      serverToken: 'tok1',
    });
    expect(targetSlugs).toEqual(['b']);
  });

  it('delta mode: when the pipeline token DIFFERS, selects every local slug', () => {
    const { targetSlugs } = computePublishPlan({
      local,
      remote: { a: 'hashA', b: 'hashB', c: 'hashC' }, // all HTML hashes match
      mode: 'delta',
      localToken: 'tok2', // pipeline changed
      serverToken: 'tok1',
    });
    expect(targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });

  it('delta mode: missing server token (never-published / legacy) forces all slugs', () => {
    const { targetSlugs } = computePublishPlan({
      local,
      remote: { a: 'hashA', b: 'hashB', c: 'hashC' },
      mode: 'delta',
      localToken: 'tok1',
      serverToken: undefined,
    });
    expect(targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });

  it('delta mode: tokens omitted entirely preserves pre-#2727 HTML-diff behavior', () => {
    const { targetSlugs } = computePublishPlan({
      local,
      remote: { a: 'hashA', b: 'DIFFERENT', c: 'hashC' },
      mode: 'delta',
    });
    expect(targetSlugs).toEqual(['b']);
  });

  it('force mode: still selects every local slug regardless of tokens', () => {
    const { targetSlugs } = computePublishPlan({
      local,
      remote: {},
      mode: 'force',
      localToken: 'tok1',
      serverToken: 'tok1',
    });
    expect(targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });
});
