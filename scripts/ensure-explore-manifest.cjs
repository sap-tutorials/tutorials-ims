// Self-heal guard chained into `npm run dev` via `&&`. Ensures
// hugo/data/explore_bundle.json exists BEFORE `hugo server` starts, so the
// /explore page never falls through to the visible "Explore bundle missing"
// fallback in hugo/layouts/explore/single.html on a fresh worktree.
//
// Why chained && and not a `predev` lifecycle hook?
//   The project's global npm config sets `ignore-scripts=true` as a
//   supply-chain-security policy, which blocks ALL pre/post npm lifecycle
//   hooks (verified: a `prefoo` script does not fire). The existing `predev`
//   entry in package.json is therefore dead under this config. Chaining the
//   guard directly into the `dev` script with `&&` is the reliable pattern —
//   the same reason check-explore-bundle-manifest.cjs chains into build:hugo.
//
// The manifest is gitignored (issue #744) — it is a generated artifact, never
// committed — so it is legitimately absent on every fresh checkout/worktree.
// `hugo server` (npm run dev) does not build it, hence this self-heal.
//
// Three paths, cheapest first:
//   1. Manifest present            -> no-op, exit 0 (zero penalty, the norm).
//   2. Manifest absent, dist present -> regenerate manifest only (~1s).
//   3. Both absent                 -> full `npm run build:explore` (~1min).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'hugo/data/explore_bundle.json');
const DIST_INDEX = path.join(ROOT, 'app/explore/dist/index.html');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT });
  if (r.status !== 0) {
    console.error(`[ensure-explore-manifest] \`${cmd} ${args.join(' ')}\` failed (exit ${r.status ?? 1}).`);
    process.exit(r.status || 1);
  }
}

if (fs.existsSync(MANIFEST)) {
  process.exit(0); // fast path — nothing to do
}

if (fs.existsSync(DIST_INDEX)) {
  console.error('[ensure-explore-manifest] manifest missing but app/explore/dist present — regenerating manifest only.');
  run('npm', ['run', 'build:explore-manifest']);
} else {
  console.error('[ensure-explore-manifest] manifest and app/explore/dist both missing — running full build:explore (one-time, ~1min).');
  run('npm', ['run', 'build:explore']);
}
