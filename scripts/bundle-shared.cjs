#!/usr/bin/env node
// Bundles workspace packages into self-contained ESM artifacts for CF deploy.
// Mirrors prebuild:parsers-bundle. @sap/* and other CF-provided packages are
// marked external and must be available in the CF runtime environment.
// Output is ESM (.mjs) with a createRequire banner for any CJS interop.
//
// .cjs handling (packages/content and packages/channels):
// CJS files are loaded at runtime via createRequire(import.meta.url) + require('./x.cjs').
// esbuild's ESM bundler cannot inline these as they are CJS singletons.
// They are marked external and copied alongside the bundle to 'srv/lib/_shared/'.

const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const outDir = 'srv/lib/_shared';
fs.mkdirSync(outDir, { recursive: true });

// srv-mcp gets its own _shared/ with core + mcp bundles only
// (no content/kg/channels needed for the 7 MCP read/write tools).
const outDirMcp = 'srv-mcp/lib/_shared';
fs.mkdirSync(outDirMcp, { recursive: true });

// 7 .cjs files from packages/content that must be copied beside the bundle.
const CONTENT_CJS = [
  'attachment-ingest.cjs',
  'attachment-mime.cjs',
  'attachment-store.cjs',
  'image-ingest.cjs',
  'image-store.cjs',
  'img-cdn-fetch.cjs',
  'img-cdn-retry.cjs',
];

// 4 .cjs files from packages/channels that must be copied beside the bundle.
const CHANNELS_CJS = [
  'normalize.cjs',
  'promote-to-shelves.cjs',
  'seed-channel-topic-map.cjs',
  'seed-collections.cjs',
];

const targets = [
  {
    entry: require.resolve('@tutorials/core'),
    out: path.join(outDir, 'core.bundle.mjs'),
  },
  {
    entry: require.resolve('@tutorials/content'),
    out: path.join(outDir, 'content.bundle.mjs'),
    // Mark the 7 .cjs files as external so esbuild doesn't try to inline them.
    // They will be copied beside the bundle below.
    extraExternal: CONTENT_CJS.map(f => `./${f}`),
  },
  {
    entry: require.resolve('@tutorials/mcp'),
    out: path.join(outDir, 'mcp.bundle.mjs'),
  },
  {
    entry: require.resolve('@tutorials/kg'),
    out: path.join(outDir, 'kg.bundle.mjs'),
  },
  {
    entry: require.resolve('@tutorials/channels'),
    out: path.join(outDir, 'channels.bundle.mjs'),
    // Mark the 4 channels .cjs files as external (CJS singletons, ship alongside).
    extraExternal: CHANNELS_CJS.map(f => `./${f}`),
  },
];

for (const t of targets) {
  esbuild.buildSync({
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: [
      '@sap/*',
      '@cap-js/*',
      '@sap-ai-sdk/*',
      'node:*',
      'hdb',
      '@sap/hana-client',
      'cheerio',
      ...(t.extraExternal || []),
    ],
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
  console.log('bundled', t.out);
}

// Copy the 7 .cjs files from packages/content beside the content bundle
// so the createRequire('./x.cjs') calls in image-source-handler /
// attachment-source-handler resolve at CF runtime.
const contentPkgDir = path.dirname(require.resolve('@tutorials/content'));
for (const cjsFile of CONTENT_CJS) {
  const src = path.join(contentPkgDir, cjsFile);
  const dst = path.join(outDir, cjsFile);
  fs.copyFileSync(src, dst);
  console.log('copied', dst);
}

// Copy the 4 .cjs files from packages/channels beside the channels bundle.
const channelsPkgDir = path.dirname(require.resolve('@tutorials/channels'));
for (const cjsFile of CHANNELS_CJS) {
  const src = path.join(channelsPkgDir, cjsFile);
  const dst = path.join(outDir, cjsFile);
  fs.copyFileSync(src, dst);
  console.log('copied', dst);
}

// srv-mcp/lib/_shared/ — core + mcp only (7 MCP tools don't need content/kg/channels).
const mcpTargets = [
  {
    entry: require.resolve('@tutorials/core'),
    out: path.join(outDirMcp, 'core.bundle.mjs'),
  },
  {
    entry: require.resolve('@tutorials/mcp'),
    out: path.join(outDirMcp, 'mcp.bundle.mjs'),
  },
];

for (const t of mcpTargets) {
  esbuild.buildSync({
    entryPoints: [t.entry],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: [
      '@sap/*',
      '@cap-js/*',
      '@sap-ai-sdk/*',
      'node:*',
      'hdb',
      '@sap/hana-client',
      'cheerio',
    ],
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  });
  console.log('bundled', t.out);
}
