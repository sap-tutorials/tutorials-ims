import { describe, it, expect } from 'vitest';
import { applySourceHashShortCircuit, computePublishPlan, validateFlagCombo } from '../publish-content.js';

describe('validateFlagCombo', () => {
  it('rejects --force + --heal', () => {
    expect(() => validateFlagCombo({ force: true, heal: true, verifyOnly: false }))
      .toThrow(/mutually exclusive/i);
  });
  it('rejects --verify-only + --heal', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: true }))
      .toThrow(/mutually exclusive/i);
  });
  it('accepts a single mode flag', () => {
    expect(() => validateFlagCombo({ force: true,  heal: false, verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: true,  verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true  })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false })).not.toThrow();
  });
});

describe('computePublishPlan', () => {
  const local = new Map<string, string>([
    ['a', 'h_a'], ['b', 'h_b'], ['c', 'h_c'],
  ]);

  it('force mode publishes every local slug', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a' }, mode: 'force' });
    expect(out.targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });
  it('delta mode publishes only changed/missing slugs', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'delta' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
  it('heal mode is the same set as delta', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'heal' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
});

describe('applySourceHashShortCircuit', () => {
  // Default fixture: 4 slugs, each with a localHtml hash. The interesting axis
  // is which combination of source-md / rendered-HTML matches the server.
  //   a — both sourceHash and htmlHash match → drop (correctly in sync)
  //   b — sourceHash matches, htmlHash differs → KEEP (template changed,
  //       source-md unchanged; the bug fixed by this test)
  //   c — sourceHash differs, htmlHash matches → keep (source-md edited,
  //       templates re-rendered same bytes; unlikely but not safe to skip)
  //   d — both differ → keep (normal edit)
  const targetSlugs = ['a', 'b', 'c', 'd'];
  const localSource = new Map<string, string>([
    ['a', 'src_a'], ['b', 'src_b'], ['c', 'src_c_local'], ['d', 'src_d_local'],
  ]);
  const serverSource: Record<string, string> = {
    a: 'src_a', b: 'src_b', c: 'src_c_server', d: 'src_d_server',
  };
  const localHtml = new Map<string, string>([
    ['a', 'html_a'], ['b', 'html_b_local'], ['c', 'html_c'], ['d', 'html_d_local'],
  ]);
  const serverHtml: Record<string, string> = {
    a: 'html_a', b: 'html_b_server', c: 'html_c', d: 'html_d_server',
  };

  it('drops slugs only when BOTH source AND html match the server', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs, localSource, serverSource, localHtml, serverHtml,
    });
    // 'a' dropped; 'b' kept (the regression fix); 'c' + 'd' kept
    expect(out.sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps slug when source matches but rendered HTML differs (template-change case)', () => {
    // This is the failure mode of rebuild-content run 28304515829 (2026-06-27).
    // PRs #682/#679/#688 changed Hugo templates without touching source markdown,
    // so every slug had matching source-md but drifted rendered-HTML. The original
    // source-only short-circuit incorrectly dropped them; auto-verify then caught
    // the 1368 stale-HTML slugs and exited 2.
    const out = applySourceHashShortCircuit({
      targetSlugs: ['b'],
      localSource: new Map([['b', 'same_src']]),
      serverSource: { b: 'same_src' },
      localHtml: new Map([['b', 'new_html_from_template_change']]),
      serverHtml: { b: 'old_html_from_prior_publish' },
    });
    expect(out).toEqual(['b']);
  });

  it('keeps slug when local source hash is missing (special slug or fresh content)', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['x'],
      localSource: new Map(),  // no entry for 'x'
      serverSource: { x: 'whatever' },
      localHtml: new Map([['x', 'html_x']]),
      serverHtml: { x: 'html_x' },
    });
    expect(out).toEqual(['x']);
  });

  it('keeps slug when server source hash is missing (new slug not yet on server)', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['y'],
      localSource: new Map([['y', 'src_y']]),
      serverSource: {},  // server doesn't know about 'y'
      localHtml: new Map([['y', 'html_y']]),
      serverHtml: { y: 'html_y' },
    });
    expect(out).toEqual(['y']);
  });

  it('keeps slug when local html hash is missing', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['z'],
      localSource: new Map([['z', 'src_z']]),
      serverSource: { z: 'src_z' },
      localHtml: new Map(),  // shouldn't happen in practice but defensive
      serverHtml: { z: 'html_z' },
    });
    expect(out).toEqual(['z']);
  });

  it('keeps slug when server html hash is missing (server in inconsistent state)', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['w'],
      localSource: new Map([['w', 'src_w']]),
      serverSource: { w: 'src_w' },
      localHtml: new Map([['w', 'html_w']]),
      serverHtml: {},  // partial server state — be safe and re-publish
    });
    expect(out).toEqual(['w']);
  });

  it('returns empty when all slugs are fully in sync', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['a'],
      localSource: new Map([['a', 'src']]),
      serverSource: { a: 'src' },
      localHtml: new Map([['a', 'html']]),
      serverHtml: { a: 'html' },
    });
    expect(out).toEqual([]);
  });

  it('returns input unchanged when nothing matches', () => {
    const out = applySourceHashShortCircuit({
      targetSlugs: ['a', 'b'],
      localSource: new Map([['a', 'src_a'], ['b', 'src_b']]),
      serverSource: { a: 'OTHER_a', b: 'OTHER_b' },
      localHtml: new Map([['a', 'html_a'], ['b', 'html_b']]),
      serverHtml: { a: 'OTHER_a', b: 'OTHER_b' },
    });
    expect(out.sort()).toEqual(['a', 'b']);
  });
});
