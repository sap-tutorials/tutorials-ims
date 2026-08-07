// scripts/check-ui5-controller-extensions.ts
//
// Build-time guard against UI5 controller-suffix-collision bugs (#362, #539).
//
// Two opposite filename-vs-loader-path bugs both produce the same observable
// symptom: a 404 in DevTools when the user interacts with the broken control,
// and no test or build step fails. The script catches both at build time.
//
// === Direction A: controllerExtensions[*].controllerName (#362) ===
//
// UI5's `sap/ui/core/mvc/ControllerExtension` loader requires extension files
// registered via `manifest.json` `sap.ui.controllerExtensions` to follow the
// `<Name>.controller.js` filename convention. If the file is named `<Name>.js`
// (no `.controller.` infix), UI5 silently logs `net::ERR_ABORTED 404` for
// `<Name>.controller.js` and the entire host Object Page fails to bootstrap.
// Surfaced 2026-06-16 cutover rehearsal (PR #353): missions ObjectPage was
// broken for 4 days because PR #307 added BranchAnalyticsHandler.js but
// registered it as a controllerName.
//
// === Direction B: press: "<dotted-name>.<methodName>" (#539) ===
//
// Fiori Elements V4 resolves `press:` references in manifest action config
// as PLAIN modules — loader path is `<dotted-name>.js`, NOT
// `<dotted-name>.controller.js`. If the file on disk is the controller-form
// variant, the click produces a 404 with no visible UI feedback. This bit
// us at least three times before the lint caught up:
//   - PR #405 (Advocates header avatar broken until renamed)
//   - PR #537 (Concepts "Trigger Graph Rebuild" broken until .js mirror added)
//   - #538 (Categories admin actions latent, predicted)
//
// Both directions coexist in this single script. Output prints distinct hints
// per direction so the remediation is obvious.
//
// === Direction C: hardcoded standalone FE view id (#1105, #1530) ===
//
// A plain-module toolbar handler (Direction B file) that needs the host
// ListReport/ObjectPage view sometimes resolves it via the STANDALONE FE
// container id, e.g.
//   sap.ui.getCore().byId(
//     "container-sap.tutorials.admin.tags---sap.fe.templates.ListReport.view.ListReport")
// That id only exists under standalone `cds watch`. Inside the admin-shell
// every admin app runs as a lazy `componentUsage` whose view id is the
// routing-target id (`sap.tutorials.admin.tags::TagsList`), so the hardcoded
// lookup returns null → "Could not resolve the ... view" on every press in
// the shell, while standalone stays green — so it ships (PATs #1105, Tags
// #1530). The robust fix is ElementRegistry-based resolution (anchor on the
// deterministic inner-table id + view-id-suffix scan). This direction fails
// the build if any `ext/*.js` hardcodes the `container-<sap.app.id>---...`
// view id string.
//
// === How it works ===
//
//   1. Walk every `app/admin/*/webapp/manifest.json` (and admin-shell).
//   2. Direction A: extract `controllerName` values from
//      `sap.ui5.extends.extensions.sap.ui.controllerExtensions[*]`.
//      Assert `<path>.controller.js` exists.
//   3. Direction B: walk the manifest tree for every `press: "<m>.<n>"`
//      string, extract the dotted module prefix, dedupe by module.
//      Assert `<module>.js` exists (NOT only `.controller.js`).
//   4. Direction C: for every `ext/*.js` beside the manifest, assert it does
//      NOT hardcode the standalone `container-<sap.app.id>---...` view id.
//
// Designed to run as part of `postbuild:apps` in package.json. Exit code 1
// on any mismatch; stderr prints the offending entry + expected file path.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Issue {
  manifestPath: string;
  /**
   * 'controllerExtension' for direction A, 'press' for direction B,
   * 'hardcodedViewId' for direction C.
   */
  direction: 'controllerExtension' | 'press' | 'hardcodedViewId';
  /** The dotted module ID from the manifest (or the offending ext/*.js path for C). */
  moduleId: string;
  /** The path the script asserted must exist (but didn't); the hardcoded id string for C. */
  expected: string;
  hint?: string;
}

function findManifests(rootDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        // skip node_modules, dist, deploy artefacts
        if (['node_modules', 'dist', 'deploy', 'build'].includes(ent.name)) continue;
        walk(p);
      } else if (ent.isFile() && ent.name === 'manifest.json' && p.includes(`${'webapp'}${sep}`)) {
        out.push(p);
      }
    }
  }
  walk(rootDir);
  return out;
}

// Recursively collect every `controllerName` value found anywhere under
// `sap.ui.controllerExtensions[*]`. The shape is:
//   "extends": { "extensions": { "sap.ui.controllerExtensions": {
//     "<host-controller-name>": { "controllerName": "<extension-module-id>" }
//   } } }
// but variants exist (extensions can be arrays of objects per host).
export function collectControllerNames(node: unknown, acc: string[] = []): string[] {
  if (!node) return acc;
  if (typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectControllerNames(item, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'controllerName' && typeof v === 'string') acc.push(v);
    else collectControllerNames(v, acc);
  }
  return acc;
}

// #539: walk the manifest tree for `press: "<module>.<method>"` strings.
// Returns deduped dotted-module IDs (the prefix; we don't care about the
// method for the file-existence check). Filters out:
//   - press values without a dot (single identifier — not a module ref)
//   - press values starting with '.' (FE V4 controller-extension-local handler)
export function collectPressTargets(node: unknown): string[] {
  const acc = new Set<string>();
  function walk(n: unknown) {
    if (!n) return;
    if (typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === 'press' && typeof v === 'string') {
        if (v.startsWith('.')) continue;  // controller-extension-local handler
        const lastDot = v.lastIndexOf('.');
        if (lastDot <= 0) continue;       // no dotted prefix
        const modulePath = v.slice(0, lastDot);
        if (!modulePath.includes('.')) continue;  // single identifier, not a module ref
        acc.add(modulePath);
      } else {
        walk(v);
      }
    }
  }
  walk(node);
  return [...acc];
}

// Direction C (#1105, #1530): detect a hardcoded standalone FE container view
// id for THIS app inside a source file. The standalone FE id has the shape
//   container-<sap.app.id>---sap.fe.templates.<Template>.view.<Template>
// which is absent when the app runs as a componentUsage in the admin-shell.
// Pure string scan (regex-free) so it can't produce false positives on the
// legitimate ElementRegistry-based resolution. Returns the matching id
// substrings found (empty when clean).
export function findHardcodedContainerViewIds(
  source: string,
  appNamespace: string,
): string[] {
  const needle = `container-${appNamespace}---sap.fe.templates`;
  const hits: string[] = [];
  let from = 0;
  for (;;) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    // Capture up to the closing quote for a readable diagnostic.
    let end = idx;
    while (end < source.length && source[end] !== '"' && source[end] !== "'") end++;
    hits.push(source.slice(idx, end));
    from = idx + needle.length;
  }
  return hits;
}

// Collect every `*.js` file directly under an app's `ext/` folder (the home
// of Direction B plain-module handlers). We scan file CONTENT for Direction C,
// so we skip `.controller.js` siblings — those are registered CEs, not the
// files FE V4 loads for press: handlers, and a comment mentioning the old id
// there is harmless. Non-recursive: ext/ is flat in every admin app today.
function collectExtJsFiles(webappDir: string): string[] {
  const extDir = join(webappDir, 'ext');
  if (!existsSync(extDir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(extDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.js')) continue;
    if (ent.name.endsWith('.controller.js')) continue;
    out.push(join(extDir, ent.name));
  }
  return out;
}

// Resolve a UI5 module ID like "sap.tutorials.admin.missions.ext.BranchAnalyticsHandler"
// to its path under <appWebappDir>/<sub>/<Name>. The first N segments are the
// app's namespace (read from manifest's `sap.app.id`) which we strip.
export function resolveModulePath(
  controllerName: string,
  appNamespace: string,
  webappDir: string,
): { jsPath: string; controllerJsPath: string } {
  const nsParts = appNamespace.split('.');
  const idParts = controllerName.split('.');

  // Strip the namespace prefix from the module ID (case-insensitive equality).
  let i = 0;
  while (i < nsParts.length && i < idParts.length && nsParts[i] === idParts[i]) i++;
  const relative = idParts.slice(i);
  const fileBase = relative[relative.length - 1];
  const subdirs = relative.slice(0, -1);

  const baseDir = join(webappDir, ...subdirs);
  return {
    jsPath: join(baseDir, `${fileBase}.js`),
    controllerJsPath: join(baseDir, `${fileBase}.controller.js`),
  };
}

function checkManifest(manifestPath: string): Issue[] {
  const issues: Issue[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return [{
      manifestPath,
      direction: 'controllerExtension',
      moduleId: '',
      expected: '',
      hint: `Failed to parse manifest.json: ${(e as Error).message}`,
    }];
  }

  const sapApp = manifest['sap.app'] as Record<string, unknown> | undefined;
  const appNamespace = typeof sapApp?.id === 'string' ? sapApp.id : undefined;
  if (!appNamespace) return issues;

  const webappDir = dirname(manifestPath);

  // Direction A: controllerExtensions → <Name>.controller.js
  const controllerNames = collectControllerNames(manifest);
  for (const cn of controllerNames) {
    if (!cn.startsWith(appNamespace + '.')) continue; // external controller; not our concern
    const { jsPath, controllerJsPath } = resolveModulePath(cn, appNamespace, webappDir);

    const hasControllerJs = existsSync(controllerJsPath) && statSync(controllerJsPath).isFile();
    if (hasControllerJs) continue;

    const hasPlainJs = existsSync(jsPath) && statSync(jsPath).isFile();
    issues.push({
      manifestPath,
      direction: 'controllerExtension',
      moduleId: cn,
      expected: controllerJsPath,
      hint: hasPlainJs
        ? `File exists at ${jsPath} but UI5 expects the .controller.js suffix. Rename the file.`
        : `Neither ${controllerJsPath} nor ${jsPath} exists. Check the controllerName spelling.`,
    });
  }

  // Direction B (#539): press: "<module>.<method>" → <module>.js
  const pressTargets = collectPressTargets(manifest);
  for (const pt of pressTargets) {
    if (!pt.startsWith(appNamespace + '.')) continue;  // external module; not our concern
    const { jsPath, controllerJsPath } = resolveModulePath(pt, appNamespace, webappDir);

    const hasPlainJs = existsSync(jsPath) && statSync(jsPath).isFile();
    if (hasPlainJs) continue;

    const hasControllerJs = existsSync(controllerJsPath) && statSync(controllerJsPath).isFile();
    issues.push({
      manifestPath,
      direction: 'press',
      moduleId: pt,
      expected: jsPath,
      hint: hasControllerJs
        ? `File exists at ${controllerJsPath} but FE V4 press: refs need a plain .js module. Add a sibling ${fileBase(jsPath)} that mirrors the handlers. See PR #537 (Concepts) for the canonical pattern.`
        : `Neither ${jsPath} nor ${controllerJsPath} exists. Check the press: target spelling.`,
    });
  }

  // Direction C (#1105, #1530): scan ext/*.js for a hardcoded standalone FE
  // container view id belonging to THIS app.
  for (const jsFile of collectExtJsFiles(webappDir)) {
    let src: string;
    try {
      src = readFileSync(jsFile, 'utf-8');
    } catch {
      continue;
    }
    for (const badId of findHardcodedContainerViewIds(src, appNamespace)) {
      issues.push({
        manifestPath,
        direction: 'hardcodedViewId',
        moduleId: jsFile,
        expected: badId,
        hint: `Hardcoded standalone FE view id "${badId}..." resolves to null inside the admin-shell (the app runs as a componentUsage; its view id is the routing-target id, not the container-<app> id). Resolve the view via sap/ui/core/ElementRegistry instead — anchor on the inner-table id and/or scan for the view by id suffix. See PatActionsController.js / TagImportController.js (#1105, #1530).`,
      });
    }
  }

  return issues;
}

function fileBase(p: string): string {
  return p.split(sep).pop() ?? p;
}

export function main(): number {
  const cwd = process.cwd();
  const adminAppsDir = resolve(cwd, 'app');
  const manifests = findManifests(adminAppsDir);

  if (manifests.length === 0) {
    console.log('[check-ui5-controller-extensions] No manifest.json files found under app/. Nothing to check.');
    return 0;
  }

  const allIssues: Issue[] = [];
  for (const m of manifests) {
    allIssues.push(...checkManifest(m));
  }

  if (allIssues.length === 0) {
    console.log(`[check-ui5-controller-extensions] OK — checked ${manifests.length} manifests, all controllerExtensions and press: refs resolve to the correct file.`);
    return 0;
  }

  console.error(`\n✗ check-ui5-controller-extensions: ${allIssues.length} mismatch${allIssues.length === 1 ? '' : 'es'}\n`);
  for (const i of allIssues) {
    console.error(`  ${i.manifestPath}`);
    const label =
      i.direction === 'press' ? "press: reference (FE V4)"
      : i.direction === 'hardcodedViewId' ? "hardcoded standalone view id"
      : "controllerExtension";
    console.error(`    direction:      ${label}`);
    if (i.direction === 'hardcodedViewId') {
      console.error(`    file:           ${i.moduleId}`);
      console.error(`    hardcoded id:   ${i.expected}...`);
    } else {
      console.error(`    module ID:      ${i.moduleId}`);
      console.error(`    expected file:  ${i.expected}`);
    }
    if (i.hint) console.error(`    hint:           ${i.hint}`);
    console.error('');
  }
  console.error('UI5 controller-suffix-collision: manifest references and file names must match.');
  console.error('controllerExtensions → <Name>.controller.js  |  press: "<dotted>.<method>" → <dotted>.js');
  console.error('Hardcoded view id: resolve via ElementRegistry, never container-<app>--- ids (fails in admin-shell).');
  console.error('See #362 (direction A), #539 (direction B / PR #537), #1105/#1530 (direction C).');
  return 1;
}

// Only execute main() when this file is invoked directly via tsx, NOT when
// imported as a module by the unit tests. The pathToFileURL comparison is
// the canonical Windows-safe pattern used elsewhere (see
// scripts/migrate-from-hana.js end-of-file). The previous file-bottom
// `main()` call caused vitest to exit the test process on import.
const _isDirectInvocation = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (_isDirectInvocation) {
  process.exit(main());
}
