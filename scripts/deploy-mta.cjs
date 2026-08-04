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
//   3.5 Bundle parity     — diff the mtar's admin-UI bundle against source
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
const STRATEGIES = ['default', 'blue-green', 'incremental-blue-green'];

function parseArgs(argv) {
  const out = { env: null, dryRun: false, skipBuild: false, skipSmoke: false, strategy: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a.startsWith('--env=')) out.env = a.slice('--env='.length);
    else if (a === '--strategy') out.strategy = argv[++i];
    else if (a.startsWith('--strategy=')) out.strategy = a.slice('--strategy='.length);
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
// Deploy lifecycle alert ping (best-effort). POSTs to the srv's
// /ops/deploy-event, which raises an ANS alert. NEVER throws, NEVER changes the
// deploy exit code — a down/misconfigured alerting path must not block a deploy.
// deps is a test seam: { fetchImpl, apiKey, log }.
// ---------------------------------------------------------------------------
async function notifyDeploy(phase, cfg, extra = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.CONTENT_API_KEY;
  const logFn = deps.log || warn;
  if (!apiKey) {
    logFn(`deploy-event ${phase}: CONTENT_API_KEY not set — skipping alert ping`);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`${cfg.srvUrl}/ops/deploy-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ phase, ...extra }),
      signal: controller.signal,
    });
    if (!res.ok) logFn(`deploy-event ${phase}: srv returned ${res.status} (ignored)`);
  } catch (e) {
    logFn(`deploy-event ${phase}: ping failed (ignored) — ${e.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
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

// Resolve the newest .mtar to an explicit DEPLOY_DIR-relative path.
// WHY (issue #1226): on Windows (git-bash driving cf.exe) the `mta_archives/*.mtar`
// glob is NOT expanded, so multiapps-cli-plugin receives the literal path and
// panics with a nil-pointer dereference in getMtaArchive — killing the script
// before the Step 5 smoke gate can run. Resolving the filename in Node is
// portable (Linux CI still deploys the same newest mtar) and lets smoke run.
function newestMtarPath() {
  if (!fs.existsSync(MTAR_GLOB_DIR)) return null;
  const mtars = fs.readdirSync(MTAR_GLOB_DIR)
    .filter(f => f.endsWith('.mtar'))
    .map(f => ({ f, m: fs.statSync(path.join(MTAR_GLOB_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  // Relative to DEPLOY_DIR (the cf deploy cwd), matching the previous glob base.
  return mtars.length ? path.join('mta_archives', mtars[0].f) : null;
}

// ---------------------------------------------------------------------------
// Step 1.5 helper: write srv/version.json so the deployed srv can report its
// build facts at GET /version (srv/lib/version-handler.js), which the Admin
// Console header reads to show the deployed MTA version as the env-badge
// tooltip (feat b337cb72). CI's deploy.yml already writes this file from
// `git describe`; local deploys (this script — the canonical DEV path, since CI
// is bypassed for ad-hoc deploys) never did, so /version fell back to
// {version:"dev"} and the tooltip was suppressed on every locally-deployed env.
//
// Source of truth for the version is the SAME `.deploy/mta.yaml` `version:`
// field cf actually deploys — so the tooltip matches `cf mtas` exactly. The
// file lands at repo-root srv/version.json; `cds build --production` copies it
// into gen/srv/srv/version.json (verified), where the handler reads it via
// `../version.json` from srv/lib. It is gitignored — a pure build artifact,
// rewritten every deploy (CI treats it as ephemeral too).
const VERSION_FILE = path.join(ROOT, 'srv', 'version.json');
const MTA_YAML = path.join(DEPLOY_DIR, 'mta.yaml');

function readMtaVersion() {
  const txt = fs.readFileSync(MTA_YAML, 'utf8');
  // Top-level `version:` line (not indented) — the MTA descriptor's own field.
  const m = txt.match(/^version:\s*(\S+)/m);
  return m ? m[1] : null;
}

function writeVersionFile() {
  const version = readMtaVersion();
  if (!version) die(1, `could not read \`version:\` from ${path.relative(ROOT, MTA_YAML)}.`);
  const sha = shCapture('git', ['rev-parse', '--short', 'HEAD']).stdout.trim() || 'unknown';
  const builtAt = new Date().toISOString();
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version, gitSha: sha, builtAt }, null, 2) + '\n');
  return { version, sha, builtAt };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Blue-green abort helper. A failed blue-green deploy leaves orphaned idle
// (green) apps consuming quota until the operation is aborted. Mirror the CI
// safety net (deploy.yml "Abort blue-green on failure"): find the errored op
// via `cf mta-ops` and abort it. Best-effort — if we can't auto-detect the op,
// print the manual command so the operator can finish the cleanup.
// ---------------------------------------------------------------------------
function abortFailedBlueGreen() {
  const ops = shCapture('cf', ['mta-ops', '--last', '5']);
  const line = ops.stdout.split(/\r?\n/)
    .find(l => /tutorials-ims/.test(l) && /(error|abort)/i.test(l));
  const opId = line ? line.trim().split(/\s+/)[0] : null;
  if (opId && /^\d+$/.test(opId)) {
    warn(`aborting failed blue-green operation ${opId} to free idle (green) apps…`);
    sh('cf', ['deploy', '-i', opId, '-a', 'abort']);
  } else {
    warn('could not auto-detect the failed blue-green op id. Abort it manually:');
    warn('             cf mta-ops            # find the ERROR/ABORTED op id');
    warn('             cf deploy -i <OP_ID> -a abort');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage: npm run deploy -- --env <dev|qa|prod> [--strategy <default|blue-green|incremental-blue-green>] [--dry-run] [--skip-build] [--skip-smoke]

  --strategy   Deployment strategy passed to \`cf deploy\`. Default is "default"
               (plain in-place deploy). "blue-green" brings up new (green) apps
               alongside the live (blue) set, then PAUSES for verification — resume
               the swap with \`cf deploy -i <OP_ID> -a resume\` (or abort with -a abort).
               Zero-downtime; the flag omits --skip-testing-phase deliberately so the
               swap is operator-gated. CI uses blue-green for prod automatically.`);
    process.exit(0);
  }
  if (args.unknown) die(1, `unknown argument: ${args.unknown}`);
  if (!args.env || !ENVS[args.env]) {
    die(1, `--env must be one of: ${Object.keys(ENVS).join(', ')}. Got: ${args.env ?? '(none)'}`);
  }
  if (!STRATEGIES.includes(args.strategy)) {
    die(1, `--strategy must be one of: ${STRATEGIES.join(', ')}. Got: ${args.strategy}`);
  }
  const envName = args.env;
  const cfg = ENVS[envName];
  let deployVersion;

  console.log(C.cyn('\n══════════════════════════════════════════════════════'));
  console.log(C.cyn(`  Deploy → ${envName.toUpperCase()}`) + (args.dryRun ? C.ylw('  (DRY RUN)') : '') + (args.strategy !== 'default' ? C.ylw(`  [${args.strategy}]`) : ''));
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

  // ---- Step 1.1: gameboard-url env-parity guard ------------------------
  // The approuter's /gameboard/* route forwards to ${gameboard-url}. The base
  // mta.yaml default is an invalid placeholder, so a missing per-env override
  // would forward to a wrong host (config-cross-env-leak). This gate fails the
  // deploy loudly if deploy/<env>.mtaext hasn't supplied a real https URL.
  step(1.1, 'gameboard-url override present for this env');
  {
    const code = sh('npx', ['tsx', 'scripts/check-gameboard-url-mtaext.ts', envName]);
    if (code !== 0) {
      die(1, `gameboard-url is not overridden for env "${envName}". ` +
             `Add a parameters.gameboard-url to deploy/${envName}.mtaext (only once that ` +
             `env's gameboard backend exists), or remove the /gameboard route for this env.`);
    }
  }

  // ---- Step 1.5: write srv/version.json --------------------------------
  // Must run BEFORE the build so `cds build` packages it into gen/srv. This is
  // what makes the deployed srv report its real MTA version at GET /version
  // (and thus the Admin header env-badge tooltip). --skip-build reuses an mtar
  // whose srv already carries a version.json, so skip then too.
  step(1.5, 'Write srv/version.json (build metadata for GET /version)');
  if (args.skipBuild) {
    warn('--skip-build: leaving the existing srv/version.json (baked into the reused mtar).');
    deployVersion = readMtaVersion();
  } else if (args.dryRun) {
    warn(`dry-run: would write ${path.relative(ROOT, VERSION_FILE)} from .deploy/mta.yaml version + git sha`);
  } else {
    const v = writeVersionFile();
    deployVersion = v.version;
    ok(`wrote srv/version.json — version ${v.version} · commit ${v.sha} · built ${v.builtAt}`);
  }

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

  // ---- Step 3.5: verify the shipped admin-UI bundle matches source ------
  // WHY (2026-07-27, PR #1331/#1345): the admin apps are raw-copied into the
  // approuter's static/admin-ui/ by the MTA's approuter builder during `mbt
  // build`. A deploy that reuses a stale mtar (--skip-build), is module-scoped
  // to the srv, or was packaged before a source change landed will ship an
  // admin UI that silently lags source — exactly how the Path Items value-help
  // fix appeared "not deployed" on DEV. This guard cracks the mtar and diffs the
  // shipped admin component files against app/admin/<name>/webapp/ BEFORE the
  // traffic-bearing deploy. It runs even on --skip-build (that is the riskiest
  // path — the whole point is to catch a stale reused mtar).
  step('3.5', 'Verify shipped admin bundle matches source');
  if (args.dryRun) {
    warn('dry-run: would diff the mtar admin-ui bundle against app/admin/ source');
  } else {
    const mtarToCheck = newestMtarPath();
    if (!mtarToCheck) {
      die(1, `no .mtar found in ${path.relative(ROOT, MTAR_GLOB_DIR)} to verify. Run without --skip-build.`);
    }
    const code = sh('node', ['scripts/check-shipped-admin-bundle.cjs', path.join(MTAR_GLOB_DIR, path.basename(mtarToCheck))]);
    if (code !== 0) {
      die(1, 'the mtar\'s admin-UI bundle does not match source (see drift above).\n' +
             '             This mtar would ship a stale admin UI. Rebuild WITHOUT --skip-build\n' +
             '             and do not use a module-scoped (-m) build for admin-UI changes.');
    }
    ok('shipped admin bundle matches source');
  }

  // ---- Step 4: cf deploy ------------------------------------------------
  const mtaext = `../deploy/${envName}.mtaext`;
  const bg = args.strategy !== 'default';
  // Strategy flags mirror CI (deploy.yml). NOTE: we intentionally do NOT pass
  // --skip-testing-phase — blue-green brings up the green apps then PAUSES so
  // the operator can verify before swapping traffic and retiring blue. Resume
  // with `cf deploy -i <OP_ID> -a resume`; abort with `-a abort`.
  const strategyFlags = bg ? ['--strategy', args.strategy] : [];
  step(4, `cf deploy (-e ${mtaext})` + (bg ? ` --strategy ${args.strategy} [pauses before swap]` : ''));
  if (args.dryRun) {
    const preview = newestMtarPath() || 'mta_archives/<newest>.mtar';
    warn(`dry-run: would run \`cf deploy ${preview} -e ${mtaext} ${strategyFlags.join(' ')} -f\` in .deploy/`);
    if (bg) warn('dry-run: blue-green would then PAUSE for verification before the traffic swap.');
  } else {
    // Pass the explicit newest mtar, NOT the `mta_archives/*.mtar` glob:
    // Windows git-bash does not expand it and cf.exe panics (issue #1226).
    const mtar = newestMtarPath();
    if (!mtar) die(1, `no .mtar found in ${path.relative(ROOT, MTAR_GLOB_DIR)} to deploy. Run without --skip-build, or build the mtar first.`);
    await notifyDeploy('start', cfg, { env: envName, version: deployVersion });
    const code = sh('cf', ['deploy', mtar, '-e', mtaext, ...strategyFlags, '-f'], { cwd: DEPLOY_DIR });
    if (code !== 0) {
      if (bg) abortFailedBlueGreen();
      await notifyDeploy('fail', cfg, { env: envName, version: deployVersion, detail: 'cf deploy failed' });
      die(1, '`cf deploy` failed. Check `cf logs` and the deployer output above.');
    }
    if (bg) {
      ok(`blue-green green apps up (${mtar}) — PAUSED before swap.`);
      warn('Verify the idle (green) apps, then swap traffic:');
      warn('             cf mta-ops                    # find the RUNNING op id');
      warn('             cf deploy -i <OP_ID> -a resume   # swap to green + retire blue');
      warn('             cf deploy -i <OP_ID> -a abort    # discard green, keep blue');
      warn('No automatic "deploy finished" alert will fire for blue-green (paused before swap).');
    } else {
      ok(`cf deploy complete (${mtar})`);
    }
  }

  // ---- Step 5: smoke gate ----------------------------------------------
  step(5, 'Smoke gate (post-deploy verification)');
  if (bg && !args.dryRun) {
    // Blue-green is PAUSED before the traffic swap: the public routes still
    // point at the old (blue) apps, so smoke here would test the OLD code and
    // tell us nothing about green. Verify green on its idle route by hand, then
    // resume the swap. Re-run smoke against the live routes AFTER the swap.
    warn('blue-green paused before swap — skipping the automatic smoke gate.');
    warn('             Public routes still serve the OLD (blue) apps; smoke now would test old code.');
    warn('             1) verify the idle (green) apps, 2) resume the swap, 3) then run:');
    warn(`             SMOKE_BASE_URL=${cfg.approuter} SMOKE_SRV_URL=${cfg.srvUrl} npm run test:smoke`);
  } else if (args.skipSmoke) {
    warn('--skip-smoke: SKIPPING post-deploy verification. This is how /explore shipped broken.');
    warn('             Run manually before trusting this deploy:');
    warn(`             SMOKE_BASE_URL=${cfg.approuter} SMOKE_SRV_URL=${cfg.srvUrl} npm run test:smoke`);
  } else if (args.dryRun) {
    warn(`dry-run: would run \`npm run test:smoke\` against ${cfg.approuter}` + (bg ? ' (AFTER the blue-green swap, not before)' : ''));
  } else {
    const smokeEnv = { ...process.env, SMOKE_BASE_URL: cfg.approuter, SMOKE_SRV_URL: cfg.srvUrl };
    const code = sh('npm', ['run', 'test:smoke'], { env: smokeEnv });
    if (code !== 0) {
      console.error('\n' + C.red('[deploy] SMOKE GATE FAILED') + ' — the deploy landed but a post-deploy check regressed.');
      console.error(C.red('         Treat the deployed env as BROKEN until this is triaged.'));
      await notifyDeploy('fail', cfg, { env: envName, version: deployVersion, detail: 'smoke gate failed' });
      process.exit(2);
    }
    ok('smoke tests passed — deploy verified');
    await notifyDeploy('end', cfg, { env: envName, version: deployVersion });
  }

  console.log('\n' + C.grn('══════════════════════════════════════════════════════'));
  const doneMsg = args.dryRun
    ? 'DRY RUN complete (nothing changed)'
    : (bg ? 'green apps deployed — PAUSED, awaiting your resume/abort of the swap' : 'complete and smoke-verified');
  console.log(C.grn(`  ${envName.toUpperCase()} deploy ${doneMsg}`));
  console.log(C.grn('══════════════════════════════════════════════════════') + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { notifyDeploy };
