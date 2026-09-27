#!/usr/bin/env node
// Fails if a package under packages/* imports a sibling feature package,
// or if core imports any feature package. core -> nothing; feature -> core only.
const fs = require('node:fs'), path = require('node:path')
const root = path.join(__dirname, '..', 'packages')
const FEATURES = new Set(['content', 'mcp', 'kg', 'channels'])
const rx = /require\(\s*['"]@tutorials\/(core|content|mcp|kg|channels)['"]/g
let errors = []
function walk(dir, pkg) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, pkg); continue }
    if (!e.name.endsWith('.js') && !e.name.endsWith('.cjs')) continue
    const src = fs.readFileSync(p, 'utf8'); let m
    while ((m = rx.exec(src))) {
      const target = m[1]
      if (pkg === 'core' && target !== 'core')
        errors.push(`core/${e.name} imports @tutorials/${target} (core must depend on nothing)`)
      if (FEATURES.has(pkg) && FEATURES.has(target) && target !== pkg)
        errors.push(`${pkg}/${e.name} imports feature @tutorials/${target} (feature->feature banned)`)
    }
  }
}
if (fs.existsSync(root))
  for (const d of fs.readdirSync(root, { withFileTypes: true }))
    if (d.isDirectory() && d.name !== '.gitkeep') walk(path.join(root, d.name), d.name)
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('package boundaries OK')
