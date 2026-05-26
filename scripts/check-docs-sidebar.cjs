#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.env.CHECK_DOCS_SIDEBAR_ROOT
  || path.resolve(__dirname, '..');
const docsRoot = path.join(repoRoot, 'docs');

const PERSONAS = ['end-users', 'authors', 'developers', 'historic'];

function loadConfig() {
  // Tests inject a .cjs sibling. Production reads .vitepress/config.ts via a require
  // hook would be heavier than needed — instead, prefer config.cjs if present, else
  // import config.ts via the TypeScript-aware path used by VitePress itself.
  const cjs = path.join(docsRoot, '.vitepress', 'config.cjs');
  if (fs.existsSync(cjs)) return require(cjs);
  const ts = path.join(docsRoot, '.vitepress', 'config.ts');
  if (!fs.existsSync(ts)) {
    console.error(`No config found at ${cjs} or ${ts}`);
    process.exit(1);
  }
  // Use VitePress's own TS compilation path. tsx is a dev dep already.
  try {
    require('tsx/cjs');
    const mod = require(ts);
    return mod.default || mod;
  } catch (err) {
    console.error(`Failed to load VitePress config at ${ts}: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

function globMatch(rel, pattern) {
  // Tiny glob: handles literal segments and `**` only (the only pattern srcExclude uses here).
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'
  );
  return re.test(rel);
}

function isExcluded(rel, srcExclude) {
  return (srcExclude || []).some(p => globMatch(rel, p));
}

function walkPersonaPages(srcExclude) {
  const found = [];
  for (const persona of PERSONAS) {
    const dir = path.join(docsRoot, persona);
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        const rel = path.relative(docsRoot, full).split(path.sep).join('/');
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md') && !isExcluded(rel, srcExclude)) {
          found.push(rel);
        }
      }
    }
  }
  return found;
}

function pageToLink(rel) {
  // docs/end-users/README.md -> /end-users/
  // docs/end-users/getting-started.md -> /end-users/getting-started
  let link = '/' + rel.replace(/\.md$/, '');
  if (link.endsWith('/README')) link = link.slice(0, -'README'.length);
  return link;
}

function linkToPage(link) {
  // /end-users/ -> end-users/README.md
  // /end-users/getting-started -> end-users/getting-started.md
  let rel = link.replace(/^\//, '').replace(/[#?].*$/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'README';
  return rel + '.md';
}

function flattenSidebar(sidebarConfig) {
  const links = [];
  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (node.link) links.push(node.link);
    if (node.items) visit(node.items);
    // VitePress sidebar can be keyed-by-prefix object — recurse only into nested objects/arrays.
    for (const k of Object.keys(node)) {
      if (k === 'link' || k === 'items' || k === 'text' || k === 'collapsed') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v);
    }
  }
  visit(sidebarConfig);
  return links;
}

function main() {
  const cfg = loadConfig();
  const sidebar = cfg.themeConfig && cfg.themeConfig.sidebar;
  if (!sidebar) {
    console.error('No themeConfig.sidebar in VitePress config');
    process.exit(1);
  }

  const srcExclude = cfg.srcExclude || [];
  const onDisk = walkPersonaPages(srcExclude);
  const sidebarLinks = flattenSidebar(sidebar)
    .filter(l => typeof l === 'string' && l.startsWith('/') && !/^https?:/.test(l));

  const onDiskLinks = new Set(onDisk.map(pageToLink));
  const sidebarSet = new Set(sidebarLinks);

  const unregistered = [...onDiskLinks].filter(l => !sidebarSet.has(l));
  const dead = sidebarLinks.filter(l => {
    const rel = linkToPage(l);
    return !fs.existsSync(path.join(docsRoot, rel));
  });

  let bad = false;
  if (unregistered.length) {
    bad = true;
    console.error('Unregistered pages (on disk but not in sidebar):');
    unregistered.sort().forEach(l => console.error('  ' + l));
  }
  if (dead.length) {
    bad = true;
    console.error('Dead sidebar links (in sidebar but not on disk):');
    dead.sort().forEach(l => console.error('  ' + l));
  }
  if (bad) process.exit(1);

  console.log(`check-docs-sidebar: ok (${onDisk.length} pages, ${sidebarLinks.length} links)`);
}

main();
