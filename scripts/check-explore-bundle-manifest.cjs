// Build-time guard chained into `build:hugo` via `&&`. Fails loudly if the
// Vite-emitted explore manifest is absent before Hugo's template render.
// See docs/superpowers/specs/2026-06-29-744-explore-into-hugo-design.md
// Section 4.1.
//
// Why a chained && instead of a `prebuild:hugo` npm lifecycle hook?
// The project's global npm config sets `ignore-scripts=true` as a
// supply-chain-security policy (see CLAUDE.md memory npm_security_config),
// which blocks ALL pre/post lifecycle hooks. Chaining keeps the guard
// reliable on Windows dev workstations regardless of that setting.
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.resolve(__dirname, '..', 'hugo/data/explore_bundle.json');
if (!fs.existsSync(MANIFEST)) {
  console.error('');
  console.error('[build:hugo] hugo/data/explore_bundle.json missing.');
  console.error('             Run `npm run build:explore` before `hugo` (or use `npm run build:all`).');
  console.error('');
  process.exit(1);
}
