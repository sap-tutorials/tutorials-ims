import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);


/**
 * #1182 — cds-caching resolve-guard fix.
 *
 * The cds-caching plugin (cds-plugin.js) injects `<plugin>/db/cache-store` and
 * `<plugin>/db/statistics` into `cds.env.roots` at plugin-load time whenever the
 * active profile has `store:'cds'` and/or `metrics.enabled` (our [hybrid] and
 * [production] profiles). That injection is what tips CF's model-resolution
 * guard past `files.length === 1` and re-merges every `requires[].model` onto
 * the precompiled srv/csn.json → "Duplicate definition" crash-loop.
 *
 * Because the build task now bakes the cds_caching entities directly into
 * srv/csn.json (see .cdsrc.json build.tasks — the srv nodejs model lists
 * `cds-caching/db/cache-store` + `cds-caching/db/statistics`), the runtime
 * root-push is REDUNDANT wherever a precompiled csn.json is loaded: KeyvCDS
 * resolves `plugin.cds_caching.CacheStore` from `cds.model.definitions`, not
 * from env.roots. So we strip exactly those plugin-injected roots when a
 * precompiled csn is present, keeping `resolve.many(env.roots)` at
 * `[srv/csn.json]` so the guard holds.
 *
 * We do NOT strip in hybrid `cds watch` (no precompiled srv/csn.json at
 * cds.root): there the model IS compiled from source roots, so the plugin roots
 * are load-bearing and must stay. In dev/unit (`store:'memory'`) the plugin
 * injects nothing, so this is a no-op.
 *
 * COUPLING CAVEAT: this strips *every* cds-caching-injected root, so the srv
 * build task (`.cdsrc.json`) MUST bake the matching models into srv/csn.json.
 * Today the plugin injects `db/cache-store` (store:'cds') + `db/statistics`
 * (metrics.enabled), and the srv nodejs task's `model` lists exactly those two.
 * If a future config enables `metrics.reuse.api`/`dashboard`, the plugin injects
 * `index` (CachingApiService) instead of/along with `db/statistics` — that model
 * would also need adding to the srv build task, or the API defs would be stripped
 * here without a csn counterpart → runtime "not found". Keep the two lists in sync.
 */

/**
 * True when `child` is `parent` itself or a path strictly under it, using
 * path-segment boundaries so a sibling like `<dir>-extra` never matches `<dir>`.
 * @param {string} parent
 * @param {string} child
 */
function isUnder(parent, child) {
  const rel = path.relative(parent, child);
  // rel === '' → same dir; rel starting with '..' or absolute → outside.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Pure function: given the current env.roots and context, return the roots to
 * keep. Does not mutate the input array.
 *
 * @param {string[]} roots - cds.env.roots (post plugin activation)
 * @param {object} opts
 * @param {string} opts.pluginDir - absolute path to the cds-caching package dir
 * @param {boolean} opts.hasPrecompiledCsn - whether srv/csn.json exists at cds.root
 * @returns {string[]} roots to keep
 */
export function computeRootsToKeep(roots, { pluginDir, hasPrecompiledCsn }) {
  if (!hasPrecompiledCsn) return [...roots];
  return roots.filter((r) => !(path.isAbsolute(r) && isUnder(pluginDir, r)));
}

/**
 * Resolve the cds-caching package dir from the runtime's module resolution.
 * Returns null if cds-caching is not installed (then there's nothing to strip).
 * @param {NodeRequire} [req]
 */
export function resolveCachingPluginDir(req = require) {
  try {
    return path.dirname(req.resolve('cds-caching/package.json'));
  } catch {
    return null;
  }
}

/**
 * Side-effecting entry point called from srv/server.js at module-eval time
 * (after `await cds.plugins` has run in cds-serve, before model resolution).
 * Strips the cds-caching-injected roots in place when a precompiled csn is
 * present, so CF's resolve-guard holds. No-op otherwise.
 *
 * @param {object} cds - the @sap/cds facade
 * @param {object} [deps] - injectable for tests
 * @param {NodeRequire} [deps.req]
 * @param {(p: string) => boolean} [deps.existsSync]
 * @returns {{ stripped: string[] }} the roots that were removed (for logging/tests)
 */
export function stripPrecompiledPluginRoots(cds, deps = {}) {
  const req = deps.req ?? require;
  const existsSync = deps.existsSync ?? fs.existsSync;

  const pluginDir = resolveCachingPluginDir(req);
  if (!pluginDir) return { stripped: [] };

  const roots = cds?.env?.roots;
  if (!Array.isArray(roots)) return { stripped: [] };

  // cds.root is always set once @sap/cds is loaded, but guard anyway: without a
  // root we can't test for a precompiled csn, so the safe default is "no strip"
  // (keep the plugin roots — the source-compilation path, never the crash path).
  if (typeof cds?.root !== 'string' || !cds.root) return { stripped: [] };

  const csnPath = path.join(cds.root, 'srv', 'csn.json');
  const hasPrecompiledCsn = existsSync(csnPath);

  const kept = computeRootsToKeep(roots, { pluginDir, hasPrecompiledCsn });
  const stripped = roots.filter((r) => !kept.includes(r));

  if (stripped.length) {
    // Mutate in place so cds-serve's subsequent resolve.all sees the trimmed
    // roots. Replace contents rather than the array reference (cds may hold a
    // reference to the same array).
    roots.length = 0;
    roots.push(...kept);
  }
  return { stripped };
}
