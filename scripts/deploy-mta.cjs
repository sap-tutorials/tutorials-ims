#!/usr/bin/env node
// scripts/deploy-mta.cjs
//
// ONE definitive deploy orchestrator. Walks the ENTIRE local-deploy flow in
// the correct order so no step can be skipped by a human OR an AI agent:
//
//   0. Preconditions      — env arg, primary-tree-on-main, cf logged in
//   1. Target guard       — cf target region + space match the chosen env
//   2. Build              — CAP_BASE_URL set per env, then `npm run build:deploy`
//   3. Package            — `mbt build`, then VERIFY a fresh mtar was produced
//   4. Deploy             — `cf deploy … -e ../deploy/<env>.mtaext -f`
//   5. Smoke gate         — `npm run test:smoke` against the just-deployed URLs
//
// WHY THIS EXISTS (2026-07-14 /explore incident):
//   A local `.deploy` deploy shipped a stale `hugo/public/` in which Hugo had
//   baked the "Explore bundle missing" fallback (the explore-ui bundle + its
//   gitignored manifest were absent). Root cause: `npm run build:all` was
//   skipped/stale before `mbt build`, and — unlike CI (deploy.yml) — the local
//   path runs NO post-deploy smoke test, so the broken page shipped silently.
//   `.deploy/mta.yaml` does not render Hugo (it copies a pre-built public/ to
//   dodge the MTA 10-min build timeout), so it is entirely dependent on the
//   operator having built first. This script removes that dependency on memory.
//
//   The existing `test/smoke/explore-route.smoke.test.js` already asserts the
//   /explore-ui/main-<hash>.js + .css bundles return 200 — it just never ran
//   locally. Step 5 wires it in. It also catches the whole class (empty
//   concepts, missing UIs, auth regressions), not just explore.
//
// WHY .cjs (not a bash script)? Cross-platform (Windows git-bash + CI Linux),
// matches the other guards under scripts/*.cjs, and global npm config sets
// `ignore-scripts=true` so a package.json lifecycle hook would not fire —
// this is invoked explicitly via `npm run deploy`.
//
// Usage:
//   npm run deploy -- --env dev
//   npm run deploy -- --env dev --dry-run        # print the plan, run guards, touch nothing
//   npm run deploy -- --env dev --skip-build      # deploy an ALREADY-built mtar (guards still run)
//   npm run deploy -- --env dev --skip-smoke      # LOUD escape hatch; discouraged
//
// Exit codes: 0 success · 1 guard/step failure · 2 smoke-gate failure.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY_DIR = path.join(ROOT, '.deploy');
const MTAR_GLOB_DIR = path.join(DEPLOY_DIR, 'mta_archives');

// ---------------------------------------------------------------------------
// ENV TABLE — the single source of truth for per-environment deploy targets.
// Mirrors docs/developers/operations/mta-deployment.md "Canonical app names
// per environment". If a URL/region changes, change it HERE and in the doc.
//   region      — token that MUST appear in `cf target` API endpoint host.
//   space       — CF space that MUST be the active `cf target` space.
//   capBaseUrl  — deployed srv; baked into CAP-sourced Hugo pages at build.
//   approuter   — deployed approuter; SMOKE_BASE_URL for the smoke gate.
//   srvUrl      — deployed srv external URL; SMOKE_SRV_URL for the smoke gate.
// ---------------------------------------------------------------------------
const ENVS = {
  dev: {
    region: 'eu10-005',
    space: 'dev',
    capBaseUrl: 'https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com',
    approuter: 'https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com',
    srvUrl: 'https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com',
  },
  qa: {
    region: 'eu10-005',
    space: 'dev',
    capBaseUrl: 'https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com',
    approuter: 'https://tutorial-system-qa-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com',
    srvUrl: 'https://tutorial-system-dev-tutorials-srv-qa.cfapps.eu10-005.hana.ondemand.com',
  },
  prod: {
    region: 'eu10-005',
    space: 'prod',
    capBaseUrl: 'https://tutorial-system-prod-tutorials-srv.cfapps.eu10-005.hana.ondemand.com',
    approuter: 'https://tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com',
    srvUrl: 'https://tutorial-system-prod-tutorials-srv.cfapps.eu10-005.hana.ondemand.com',
  },
};

// ---------------------------------------------------------------------------
// tiny arg parser + logging
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { env: null, dryRun: false, skipBuild: false, skipSmoke: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a.startsWith('--env=')) out.env = a.slice('--env='.length);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--skip-smoke') out.skipSmoke = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else { out.unknown = a; }
  }
  return out;
}

const C = { red: s => `\x1b[31m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`, ylw: s => `\x1b[33m${s}\x1b[0m`, cyn: s => `\x1b[36m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };
function step(n, msg) { console.log('\n' + C.cyn(`[deploy ${n}] `) + msg); }
function ok(msg) { console.log(C.grn('  ✓ ') + msg); }
function warn(msg) { console.log(C.ylw('  ! ') + msg); }
function die(code, msg) { console.error('\n' + C.red('[deploy] FAILED: ') + msg + '\n'); process.exit(code); }

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
  return r.status ?? 1;
}
function shCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, cwd: ROOT, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------------------
// Step 0: preconditions
// ---------------------------------------------------------------------------
function guardPrimaryTreeOnMain() {
  // Memory rule: "Deploy from primary tree on main, never a worktree." A
  // worktree base can sit ahead of / behind main and bake the wrong content.
  const branch = shCapture('git', ['branch', '--show-current']).stdout.trim();
  const gitDir = shCapture('git', ['rev-parse', '--git-dir']).stdout.trim();
  const inWorktree = /[\\/]worktrees[\\/]/.test(gitDir) || /[\\/]\.claude[\\/]worktrees[\\/]/.test(ROOT);
  if (inWorktree) {
    die(1, `deploying from a worktree (${ROOT}). Deploy from the primary checkout on main —\n` +
           `             mbt only cp's hugo/public and a worktree base can bake stale/ahead content.`);
  }
  if (branch !== 'main') {
    die(1, `current branch is "${branch}", not "main". Deploys run from the primary tree on main.`);
  }
  ok(`primary checkout on main (${branch})`);
}

function guardCfTarget(cfg, envName) {
  const t = shCapture('cf', ['target']);
  if (t.status !== 0) {
    die(1, `\`cf target\` failed — are you logged in? Run \`cf login -a https://api.cf.${cfg.region}.hana.ondemand.com\`.\n${t.stdout}${t.stderr}`);
  }
  const out = t.stdout;
  const api = (out.match(/API endpoint:\s*(\S+)/) || [])[1] || '';
  const space = (out.match(/space:\s*(\S+)/i) || [])[1] || '';
  const org = (out.match(/org:\s*(.+)/i) || [])[1]?.trim() || '';

  // The wrong-region footgun this whole exercise came from: cf was pointed at
  // us10 while the target is eu10-005. Assert the region token is in the API host.
  if (!api.includes(cfg.region)) {
    die(1, `cf target region mismatch for env "${envName}".\n` +
           `             API endpoint: ${api || '(unknown)'}\n` +
           `             expected the host to contain "${cfg.region}".\n` +
           `             Fix: cf login -a https://api.cf.${cfg.region}.hana.ondemand.com  (then re-target org/space)`);
  }
  if (space && space.toLowerCase() !== cfg.space) {
    die(1, `cf target space is "${space}", expected "${cfg.space}" for env "${envName}".\n` +
           `             Fix: cf target -s ${cfg.space}`);
  }
  ok(`cf target OK — org=${org || '?'} space=${space || '?'} api=${api}`);
}

// ---------------------------------------------------------------------------
// Step 3 helper: verify mbt produced a FRESH mtar.
// Memory: `mbt build` can silently no-op (exit 0, stale mtar) when its Go
// binary was never unpacked (ignore-scripts=true skipped mbt's postinstall).
// Trust the artifact mtime, not the exit code.
// ---------------------------------------------------------------------------
function newestMtarMtime() {
  if (!fs.existsSync(MTAR_GLOB_DIR)) return 0;
  const mtars = fs.readdirSync(MTAR_GLOB_DIR).filter(f => f.endsWith('.mtar'));
  let newest = 0;
  for (const f of mtars) {
    const m = fs.statSync(path.join(MTAR_GLOB_DIR, f)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage: npm run deploy -- --env <dev|qa|prod> [--dry-run] [--skip-build] [--skip-smoke]`);
    process.exit(0);
  }
  if (args.unknown) die(1, `unknown argument: ${args.unknown}`);
  if (!args.env || !ENVS[args.env]) {
    die(1, `--env must be one of: ${Object.keys(ENVS).join(', ')}. Got: ${args.env ?? '(none)'}`);
  }
  const envName = args.env;
  const cfg = ENVS[envName];

  console.log(C.cyn('\n══════════════════════════════════════════════════════'));
  console.log(C.cyn(`  Deploy → ${envName.toUpperCase()}`) + (args.dryRun ? C.ylw('  (DRY RUN)') : ''));
  console.log(C.cyn('══════════════════════════════════════════════════════'));
  console.log(C.dim(`  approuter: ${cfg.approuter}`));
  console.log(C.dim(`  srv:       ${cfg.srvUrl}`));

  // ---- Step 0: preconditions -------------------------------------------
  step(0, 'Preconditions');
  guardPrimaryTreeOnMain();

  // ---- Step 1: cf target guard -----------------------------------------
  step(1, `cf target must be region "${cfg.region}", space "${cfg.space}"`);
  if (args.dryRun) warn('dry-run: still checking cf target (read-only)');
  guardCfTarget(cfg, envName);

  // ---- Step 2: build ----------------------------------------------------
  step(2, `Build (CAP_BASE_URL=${cfg.capBaseUrl})`);
  if (args.skipBuild) {
    warn('--skip-build: reusing the existing mtar. Ensure it was built for THIS env.');
  } else if (args.dryRun) {
    warn(`dry-run: would run \`CAP_BASE_URL=… npm run build:deploy\``);
  } else {
    // build:deploy = check-deploy-cap-target && build:all. build:all runs
    // build:explore (Vite + manifest) BEFORE build:hugo, and build:hugo's
    // check-explore-bundle-manifest.cjs hard-fails if the manifest is absent.
    // So a green build:deploy CANNOT reproduce the /explore incident.
    const code = sh('npm', ['run', 'build:deploy'], { env: { ...process.env, CAP_BASE_URL: cfg.capBaseUrl } });
    if (code !== 0) die(1, '`npm run build:deploy` failed — fix the build before deploying.');
    ok('build:deploy complete (explore bundle + manifest included via build:all)');
  }

  // ---- Step 3: mbt build (+ fresh-mtar verify) -------------------------
  step(3, 'Package MTA (mbt build)');
  if (args.skipBuild) {
    warn('--skip-build: skipping mbt build too.');
  } else if (args.dryRun) {
    warn('dry-run: would run `mbt build` in .deploy/ and verify a fresh mtar');
  } else {
    const before = newestMtarMtime();
    // Windows note (memory): a SUCCESSFUL mbt build can end with a benign
    // "could not remove Makefile" + EXIT=1 AFTER "the MTA archive generated
    // at:". So we do not trust the exit code — we verify the mtar mtime moved.
    sh('mbt', ['build'], { cwd: DEPLOY_DIR });
    const after = newestMtarMtime();
    if (after <= before) {
      die(1, 'mbt produced no fresh mtar (mtime did not advance).\n' +
             '             Likely the mbt Go binary was never unpacked (ignore-scripts=true).\n' +
             '             Fix: (cd node_modules/mbt && node install cloud-mta-build-tool), then retry.');
    }
    ok(`fresh mtar in ${path.relative(ROOT, MTAR_GLOB_DIR)} (mtime advanced)`);
  }

  // ---- Step 4: cf deploy ------------------------------------------------
  const mtaext = `../deploy/${envName}.mtaext`;
  step(4, `cf deploy (-e ${mtaext})`);
  if (args.dryRun) {
    warn(`dry-run: would run \`cf deploy mta_archives/*.mtar -e ${mtaext} -f\` in .deploy/`);
  } else {
    const code = sh('cf', ['deploy', 'mta_archives/*.mtar', '-e', mtaext, '-f'], { cwd: DEPLOY_DIR });
    if (code !== 0) die(1, '`cf deploy` failed. Check `cf logs` and the deployer output above.');
    ok('cf deploy complete');
  }

  // ---- Step 5: smoke gate ----------------------------------------------
  step(5, 'Smoke gate (post-deploy verification)');
  if (args.skipSmoke) {
    warn('--skip-smoke: SKIPPING post-deploy verification. This is how /explore shipped broken.');
    warn('             Run manually before trusting this deploy:');
    warn(`             SMOKE_BASE_URL=${cfg.approuter} SMOKE_SRV_URL=${cfg.srvUrl} npm run test:smoke`);
  } else if (args.dryRun) {
    warn(`dry-run: would run \`npm run test:smoke\` against ${cfg.approuter}`);
  } else {
    const smokeEnv = { ...process.env, SMOKE_BASE_URL: cfg.approuter, SMOKE_SRV_URL: cfg.srvUrl };
    const code = sh('npm', ['run', 'test:smoke'], { env: smokeEnv });
    if (code !== 0) {
      console.error('\n' + C.red('[deploy] SMOKE GATE FAILED') + ' — the deploy landed but a post-deploy check regressed.');
      console.error(C.red('         Treat the deployed env as BROKEN until this is triaged.'));
      process.exit(2);
    }
    ok('smoke tests passed — deploy verified');
  }

  console.log('\n' + C.grn('══════════════════════════════════════════════════════'));
  console.log(C.grn(`  ${envName.toUpperCase()} deploy ${args.dryRun ? 'DRY RUN complete (nothing changed)' : 'complete and smoke-verified'}`));
  console.log(C.grn('══════════════════════════════════════════════════════') + '\n');
}

main();
