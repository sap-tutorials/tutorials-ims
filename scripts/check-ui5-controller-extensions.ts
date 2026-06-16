// scripts/check-ui5-controller-extensions.ts
//
// Build-time guard against UI5 controller-extension filename mismatch (#362).
//
// The bug class: UI5's `sap/ui/core/mvc/ControllerExtension` loader requires
// extension files registered via `manifest.json` `sap.ui.controllerExtensions`
// to follow the standard `<Name>.controller.js` filename convention. If the
// file is named `<Name>.js` (no `.controller.` infix), UI5 silently logs
// `net::ERR_ABORTED 404` for `<Name>.controller.js` and the entire host
// Object Page fails to bootstrap with cascading getMetadata /
// storeInnerAppStateAsync errors. Build doesn't fail; tests don't fail.
// Only manual browser interaction on the deployed app catches it.
//
// Surfaced 2026-06-16 cutover rehearsal (PR #353): missions ObjectPage was
// broken for 4 days because PR #307 added BranchAnalyticsHandler.js but
// registered it as a controllerName, which UI5 resolves with the
// `.controller.js` suffix.
//
// This script catches the bug class at build time. It:
//   1. Walks every `app/admin/*/webapp/manifest.json` (and admin-shell)
//   2. Extracts `sap.ui5.extends.extensions.sap.ui.controllerExtensions[*].controllerName`
//   3. Resolves each module ID to a file path under the app's webapp/
//   4. Asserts `<path>.controller.js` exists (NOT `<path>.js` alone)
//
// Designed to run as part of `postbuild:apps` in package.json so it fires
// alongside the existing collision/icon/srv-qa checks. Could also run
// pre-deploy.
//
// Exit codes:
//   0  no mismatch found
//   1  one or more mismatches (or script error)
//      Stderr prints the offending controllerName + expected file path

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

interface Issue {
  manifestPath: string;
  controllerName: string;
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
function collectControllerNames(node: any, acc: string[] = []): string[] {
  if (!node) return acc;
  if (typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectControllerNames(item, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'controllerName' && typeof v === 'string') acc.push(v);
    else collectControllerNames(v, acc);
  }
  return acc;
}

// Resolve a UI5 module ID like "sap.tutorials.admin.missions.ext.BranchAnalyticsHandler"
// to its path under <appWebappDir>/<sub>/<Name>. The first N segments are the
// app's namespace (read from manifest's `sap.app.id`) which we strip.
function resolveModulePath(
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
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e: any) {
    return [{
      manifestPath,
      controllerName: '',
      expected: '',
      hint: `Failed to parse manifest.json: ${e.message}`,
    }];
  }

  const appNamespace = manifest['sap.app']?.id;
  if (!appNamespace) return issues;

  const webappDir = dirname(manifestPath);
  const controllerNames = collectControllerNames(manifest);

  for (const cn of controllerNames) {
    if (!cn.startsWith(appNamespace + '.')) continue; // external controller; not our concern
    const { jsPath, controllerJsPath } = resolveModulePath(cn, appNamespace, webappDir);

    const hasControllerJs = existsSync(controllerJsPath) && statSync(controllerJsPath).isFile();
    if (hasControllerJs) continue;

    const hasPlainJs = existsSync(jsPath) && statSync(jsPath).isFile();
    issues.push({
      manifestPath,
      controllerName: cn,
      expected: controllerJsPath,
      hint: hasPlainJs
        ? `File exists at ${jsPath} but UI5 expects the .controller.js suffix. Rename the file.`
        : `Neither ${controllerJsPath} nor ${jsPath} exists. Check the controllerName spelling.`,
    });
  }

  return issues;
}

function main() {
  const cwd = process.cwd();
  const adminAppsDir = resolve(cwd, 'app');
  const manifests = findManifests(adminAppsDir);

  if (manifests.length === 0) {
    console.log('[check-ui5-controller-extensions] No manifest.json files found under app/. Nothing to check.');
    process.exit(0);
  }

  const allIssues: Issue[] = [];
  for (const m of manifests) {
    allIssues.push(...checkManifest(m));
  }

  if (allIssues.length === 0) {
    console.log(`[check-ui5-controller-extensions] OK — checked ${manifests.length} manifests, all controllerExtensions resolve to <Name>.controller.js`);
    process.exit(0);
  }

  console.error(`\n✗ check-ui5-controller-extensions: ${allIssues.length} mismatch${allIssues.length === 1 ? '' : 'es'}\n`);
  for (const i of allIssues) {
    console.error(`  ${i.manifestPath}`);
    console.error(`    controllerName: ${i.controllerName}`);
    console.error(`    expected file:  ${i.expected}`);
    if (i.hint) console.error(`    hint:           ${i.hint}`);
    console.error('');
  }
  console.error('UI5 ControllerExtension files registered via manifest.json must follow the');
  console.error('<Name>.controller.js naming convention. Without it, UI5 logs a 404 on the');
  console.error('expected path and the host Object Page fails to bootstrap (see #362).');
  process.exit(1);
}

main();
