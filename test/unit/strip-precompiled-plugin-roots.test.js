/**
 * #1182 — unit test for the cds-caching resolve-guard fix.
 *
 * Background: `cds.requires.caching.store:'cds'` (+ metrics) makes the
 * cds-caching plugin push `<plugin>/db/cache-store` and `<plugin>/db/statistics`
 * into `cds.env.roots` at plugin-load time. On CF production boot, cds-serve's
 * model-resolution guard in @sap/cds/lib/compile/resolve.js is:
 *
 *   const files = resolve.many(env.roots)
 *   const is_csn_json = files.length === 1 && files[0].endsWith('csn.json')
 *   if (!is_csn_json) files.push(...resolve.many(_required(env)))  // re-merge!
 *
 * With the two extra roots present, `resolve.many(env.roots)` returns 3 files
 * (srv/csn.json + the 2 plugin .cds), so `is_csn_json` is false and EVERY
 * `requires[].model` (@cap-js/change-tracking, outbox, data-inspector, …) is
 * recompiled ON TOP of the already-complete precompiled srv/csn.json →
 * "Duplicate definition of artifact" → crash-loop. (Reproduced locally, #1182.)
 *
 * The build task now bakes the cds_caching entities INTO srv/csn.json, so the
 * runtime root-push is redundant when a precompiled csn is present. This module
 * strips exactly those plugin-injected roots in that case, restoring
 * files.length === 1 so the guard holds. In hybrid `cds watch` (no precompiled
 * csn) the roots are kept so the plugin can compile them from source.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { computeRootsToKeep, stripPrecompiledPluginRoots } from '../../srv/lib/strip-precompiled-plugin-roots.js';

const PLUGIN_DIR = path.join('/app', 'node_modules', 'cds-caching');
const APP_ROOTS = ['db/', 'srv/', 'app/', 'app/*', 'schema', 'services'];
const CACHE_STORE_ROOT = path.join(PLUGIN_DIR, 'db', 'cache-store');
const STATISTICS_ROOT = path.join(PLUGIN_DIR, 'db', 'statistics');

describe('computeRootsToKeep — cds-caching resolve-guard fix (#1182)', () => {
  it('strips plugin-injected roots when a precompiled csn is present (production/CF)', () => {
    const roots = [...APP_ROOTS, CACHE_STORE_ROOT, STATISTICS_ROOT];
    const kept = computeRootsToKeep(roots, {
      pluginDir: PLUGIN_DIR,
      hasPrecompiledCsn: true,
    });
    expect(kept).toEqual(APP_ROOTS);
    expect(kept).not.toContain(CACHE_STORE_ROOT);
    expect(kept).not.toContain(STATISTICS_ROOT);
  });

  it('keeps plugin-injected roots when NO precompiled csn (hybrid cds watch)', () => {
    const roots = [...APP_ROOTS, CACHE_STORE_ROOT, STATISTICS_ROOT];
    const kept = computeRootsToKeep(roots, {
      pluginDir: PLUGIN_DIR,
      hasPrecompiledCsn: false,
    });
    expect(kept).toEqual(roots);
  });

  it('is a no-op when no plugin roots were injected (store:memory — dev/unit)', () => {
    const kept = computeRootsToKeep([...APP_ROOTS], {
      pluginDir: PLUGIN_DIR,
      hasPrecompiledCsn: true,
    });
    expect(kept).toEqual(APP_ROOTS);
  });

  it('only strips roots UNDER the plugin dir, never app roots that merely share a prefix', () => {
    // A hypothetical app root that starts with the plugin dir name but is a
    // sibling, not a child, must be preserved. Uses path-boundary matching.
    const lookalike = PLUGIN_DIR + '-extra';
    const roots = [...APP_ROOTS, lookalike, CACHE_STORE_ROOT];
    const kept = computeRootsToKeep(roots, {
      pluginDir: PLUGIN_DIR,
      hasPrecompiledCsn: true,
    });
    expect(kept).toContain(lookalike);
    expect(kept).not.toContain(CACHE_STORE_ROOT);
  });

  it('returns the same array instance semantics — pure, does not mutate input', () => {
    const roots = [...APP_ROOTS, CACHE_STORE_ROOT];
    const snapshot = [...roots];
    computeRootsToKeep(roots, { pluginDir: PLUGIN_DIR, hasPrecompiledCsn: true });
    expect(roots).toEqual(snapshot); // input untouched
  });
});

describe('stripPrecompiledPluginRoots — side-effecting entry point (#1182)', () => {
  const makeCds = (root, roots) => ({ root, env: { roots: [...roots] } });
  const fakeReq = { resolve: () => path.join(PLUGIN_DIR, 'package.json') };

  it('strips roots in place when precompiled csn present, keeping array reference', () => {
    const cds = makeCds('/app/gen/srv', [...APP_ROOTS, CACHE_STORE_ROOT, STATISTICS_ROOT]);
    const rootsRef = cds.env.roots; // capture the SAME array reference
    const { stripped } = stripPrecompiledPluginRoots(cds, {
      req: fakeReq,
      existsSync: () => true,
    });
    expect(stripped).toEqual([CACHE_STORE_ROOT, STATISTICS_ROOT]);
    expect(cds.env.roots).toBe(rootsRef); // same array instance (cds holds this ref)
    expect(cds.env.roots).toEqual(APP_ROOTS);
  });

  it('is a no-op when no precompiled csn (hybrid) — roots untouched', () => {
    const cds = makeCds('/app', [...APP_ROOTS, CACHE_STORE_ROOT]);
    const { stripped } = stripPrecompiledPluginRoots(cds, {
      req: fakeReq,
      existsSync: () => false,
    });
    expect(stripped).toEqual([]);
    expect(cds.env.roots).toEqual([...APP_ROOTS, CACHE_STORE_ROOT]);
  });

  it('fails safe (no strip) when cds.root is missing', () => {
    const cds = { env: { roots: [...APP_ROOTS, CACHE_STORE_ROOT] } }; // no root
    const { stripped } = stripPrecompiledPluginRoots(cds, {
      req: fakeReq,
      existsSync: () => true,
    });
    expect(stripped).toEqual([]);
    expect(cds.env.roots).toEqual([...APP_ROOTS, CACHE_STORE_ROOT]);
  });

  it('fails safe when cds-caching is not installed (resolve throws)', () => {
    const cds = makeCds('/app/gen/srv', [...APP_ROOTS, CACHE_STORE_ROOT]);
    const throwingReq = { resolve: () => { throw new Error('not found'); } };
    const { stripped } = stripPrecompiledPluginRoots(cds, {
      req: throwingReq,
      existsSync: () => true,
    });
    expect(stripped).toEqual([]);
  });

  it('fails safe when env.roots is not an array', () => {
    const cds = { root: '/app/gen/srv', env: {} };
    const { stripped } = stripPrecompiledPluginRoots(cds, {
      req: fakeReq,
      existsSync: () => true,
    });
    expect(stripped).toEqual([]);
  });
});
