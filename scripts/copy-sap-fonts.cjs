#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VARIANTS = ['72-Regular', '72-Bold', '72-Italic', '72-Light', '72-BoldItalic'];

const targetDir = process.env.COPY_SAP_FONTS_TARGET
  || path.resolve(__dirname, '..', 'docs', '.vitepress', 'public', 'fonts');

const nodeModulesDir = process.env.COPY_SAP_FONTS_NODE_MODULES
  || path.resolve(__dirname, '..', 'node_modules');

function findPackageRoot() {
  const pkg = path.join(nodeModulesDir, '@sap-theming', 'theming-base-content', 'package.json');
  if (!fs.existsSync(pkg)) {
    console.error(
      `@sap-theming/theming-base-content not found at ${pkg}. ` +
      `Run \`npm install\` and re-run this script.`
    );
    process.exit(1);
  }
  return path.dirname(pkg);
}

function findVariant(packageRoot, variant) {
  // Walk the package looking for "<variant>.woff2". Stops at first match.
  const want = `${variant}.woff2`;
  const stack = [packageRoot];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === want) return full;
    }
  }
  return null;
}

function copyIfChanged(src, dst) {
  if (fs.existsSync(dst)) {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return false;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function main() {
  const packageRoot = findPackageRoot();
  fs.mkdirSync(targetDir, { recursive: true });

  const missing = [];
  let copied = 0;
  for (const v of VARIANTS) {
    const src = findVariant(packageRoot, v);
    if (!src) { missing.push(v); continue; }
    if (copyIfChanged(src, path.join(targetDir, `${v}.woff2`))) copied++;
  }

  if (missing.length) {
    console.error(`Could not locate ${missing.length} variant(s) in @sap-theming/theming-base-content: ${missing.join(', ')}.`);
    console.error('Package layout may have changed — inspect node_modules/@sap-theming/theming-base-content/ and update scripts/copy-sap-fonts.cjs.');
    process.exit(1);
  }

  console.log(`copy-sap-fonts: ${copied} new/updated, ${VARIANTS.length - copied} up-to-date → ${targetDir}`);
}

main();
