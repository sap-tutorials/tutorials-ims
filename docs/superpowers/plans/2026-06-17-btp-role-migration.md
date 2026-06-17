# BTP Role-Collection Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-shot migration script (`scripts/migrate-btp-roles.js`) that copies BTP role-collection user assignments from the legacy IMS Prod subaccount to the new `tutorial-system` subaccount, via the `btp` CLI, with dry-run preview, confirm-required writes, and a verify diff.

**Architecture:** ES module Node script that wraps `btp --format json` subprocess calls. Three subcommands: `export` (read source → `.migration-data/btp-roles.json`), `import` (read JSON → write to target via `btp assign`), `verify` (re-read target → diff against source export). Tests use a `BTP_BIN` env-var seam pointing at a fake-`btp` Node script that echoes canned JSON.

**Tech Stack:** Node.js ≥20 (native `fetch`, ES modules), `child_process.spawn`, Vitest (`unit` project), `btp` CLI v2.97.0+ (subprocess only — never required to run during the unit test suite).

**Spec:** [docs/superpowers/specs/2026-06-17-btp-role-migration-design.md](../specs/2026-06-17-btp-role-migration-design.md)

---

## File Structure

**Created:**

- `scripts/migrate-btp-roles.js` — main script (ES module). Subcommands `export` / `import` / `verify` dispatched from `argv[2]`.
- `scripts/lib/btp-cli.js` — single-purpose helper module. Exports `runBtp(args, opts)`, `getCurrentTarget()`, `listRoleCollections()`, `getRoleCollectionUsers(name)`, `assignUser(rc, user, origin)`. Isolated from the script so it can be imported and tested without booting the CLI dispatcher.
- `scripts/__tests__/migrate-btp-roles.test.ts` — Vitest fixture-driven tests (dry-run smoke, pre-flight failures, mapping discovery, summary tally).
- `scripts/__tests__/fixtures/fake-btp.cjs` — tiny Node script that pretends to be `btp`. Reads `argv` and `BTP_FAKE_FIXTURE` env var, echoes canned JSON, exits 0/1 by config. Used via `BTP_BIN` seam.
- `docs/developers/operations/btp-role-migration.md` — operator runbook.

**Modified:**

- `CLAUDE.md` — add one-line mention of the new script under the "Data Migration" subsection (around the `migrate-reference-data.js` / `migrate-user-progress.js` paragraph).
- `docs/.vitepress/config.ts` — add sidebar entry under `Operations` (alphabetic position: between `A/B comparison runbook` and `AI-author CI setup`).
- `package.json` — add `"migrate:btp-roles": "node scripts/migrate-btp-roles.js"` script entry so `npm run migrate:btp-roles -- export` works alongside the existing `migrate:*` scripts.

**Why split `btp-cli.js` from the main script:** the main script is the dispatcher + orchestration (argv parsing, summary printing, file I/O); the helper is the subprocess boundary. Keeping them apart lets us test `runBtp` and friends in isolation, and means a future operator script (e.g. for unassign / rollback) can `import` the helper instead of forking a copy.

---

## Task 1: `btp-cli.js` helper module

Build the subprocess boundary first. Everything else depends on it.

**Files:**

- Create: `scripts/lib/btp-cli.js`
- Create: `scripts/__tests__/fixtures/fake-btp.cjs`
- Create: `scripts/__tests__/btp-cli.test.ts`

- [ ] **Step 1.1: Write the failing test for `runBtp` happy path**

`scripts/__tests__/btp-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runBtp } from '../lib/btp-cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BTP = join(HERE, 'fixtures', 'fake-btp.cjs');

describe('runBtp', () => {
  it('parses --format json stdout into data', async () => {
    const result = await runBtp(['list', 'security/role-collection'], {
      btpBin: process.execPath,
      btpBinArgs: [FAKE_BTP],
      env: { FAKE_BTP_RESPONSE: JSON.stringify([{ name: 'IMS Admin' }]) }
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ name: 'IMS Admin' }]);
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it fails**

```bash
npx vitest run scripts/__tests__/btp-cli.test.ts
```

Expected: FAIL with "Cannot find module '../lib/btp-cli.js'".

- [ ] **Step 1.3: Implement `runBtp` minimally**

`scripts/lib/btp-cli.js`:

```js
// Single-purpose helper around the `btp` CLI subprocess. Every caller goes
// through runBtp() so we have one place to inject --format json, capture
// stderr, enforce timeouts, and swap the binary for tests via BTP_BIN.
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run the BTP CLI with --format json injected, capture stdout/stderr, parse
 * stdout as JSON, return a plain result object. Never throws on nonzero exit;
 * caller decides what to do with !result.ok.
 *
 * @param {string[]} args — args after the binary, e.g. ['list', 'security/role-collection']
 * @param {object} [opts]
 * @param {string} [opts.btpBin]      override the binary (defaults to process.env.BTP_BIN || 'btp')
 * @param {string[]} [opts.btpBinArgs] extra args prepended (used in tests so node runs fake-btp.cjs)
 * @param {number} [opts.timeoutMs]   per-call timeout (default 30 s)
 * @param {object} [opts.env]         extra env vars merged into child env
 * @returns {Promise<{ok:boolean, data?:any, stderr:string, exitCode:number, raw:string}>}
 */
export async function runBtp(args, opts = {}) {
  const bin = opts.btpBin || process.env.BTP_BIN || 'btp';
  const prefix = opts.btpBinArgs || [];
  const fullArgs = [...prefix, ...args, '--format', 'json'];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise((resolve) => {
    const child = spawn(bin, fullArgs, {
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\n[runBtp] timeout after ${timeoutMs}ms`;
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      let data;
      try { data = stdout.trim() ? JSON.parse(stdout) : undefined; }
      catch { /* leave data undefined; raw still available */ }
      resolve({
        ok: exitCode === 0,
        data,
        stderr: stderr.trim(),
        exitCode: exitCode ?? -1,
        raw: stdout,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: `spawn error: ${err.message}`, exitCode: -1, raw: '' });
    });
  });
}
```

- [ ] **Step 1.4: Implement `fake-btp.cjs`**

`scripts/__tests__/fixtures/fake-btp.cjs`:

```js
// Tiny test double for the `btp` CLI. Reads canned JSON from FAKE_BTP_RESPONSE
// (or a JSON-Lines map at FAKE_BTP_FIXTURE_FILE keyed by the joined args), echoes
// it on stdout, exits with FAKE_BTP_EXIT (default 0). Captures the actual args
// to FAKE_BTP_TRACE_FILE so tests can assert call shape.
'use strict';
const fs = require('node:fs');

const args = process.argv.slice(2);

if (process.env.FAKE_BTP_TRACE_FILE) {
  fs.appendFileSync(process.env.FAKE_BTP_TRACE_FILE, JSON.stringify(args) + '\n');
}

const exitCode = parseInt(process.env.FAKE_BTP_EXIT || '0', 10);

if (process.env.FAKE_BTP_STDERR) {
  process.stderr.write(process.env.FAKE_BTP_STDERR);
}

if (process.env.FAKE_BTP_RESPONSE) {
  process.stdout.write(process.env.FAKE_BTP_RESPONSE);
}

process.exit(exitCode);
```

- [ ] **Step 1.5: Run the test to verify it passes**

```bash
npx vitest run scripts/__tests__/btp-cli.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 1.6: Add a failing test for nonzero exit**

Append to `btp-cli.test.ts`:

```ts
it('returns ok:false with stderr captured on nonzero exit', async () => {
  const result = await runBtp(['get', 'security/role-collection', 'NoSuch'], {
    btpBin: process.execPath,
    btpBinArgs: [FAKE_BTP],
    env: { FAKE_BTP_EXIT: '1', FAKE_BTP_STDERR: 'role collection not found' }
  });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('role collection not found');
});
```

Run; expected: PASS without further code changes (the helper already handles this — this test pins the contract).

- [ ] **Step 1.7: Add `getCurrentTarget`, `listRoleCollections`, `getRoleCollectionUsers`, `assignUser`**

Append to `scripts/lib/btp-cli.js`:

```js
/** Read the active subaccount/global-account from `btp target`. */
export async function getCurrentTarget(opts = {}) {
  const result = await runBtp(['target'], opts);
  if (!result.ok || !result.data) {
    throw new Error(`btp target failed: ${result.stderr || 'no JSON'}`);
  }
  // Field names vary by CLI version; normalize defensively.
  const d = result.data;
  return {
    subaccountId: d.subaccountId || d.subaccount?.guid || d.subaccount,
    subaccountSubdomain: d.subaccountSubdomain || d.subaccount?.subdomain,
    globalAccountSubdomain: d.globalAccountSubdomain || d.globalAccount?.subdomain || d.globalAccount,
  };
}

/** List role collections on the currently-targeted subaccount. */
export async function listRoleCollections(opts = {}) {
  const result = await runBtp(['list', 'security/role-collection'], opts);
  if (!result.ok) throw new Error(`btp list role-collection failed: ${result.stderr}`);
  // CLI returns either an array directly or { values: [...] } depending on version.
  const arr = Array.isArray(result.data) ? result.data : (result.data?.values || []);
  return arr;
}

/** Page through users assigned to one role collection. */
export async function getRoleCollectionUsers(name, opts = {}) {
  const all = [];
  for (let page = 1; page <= 50; page++) {  // hard cap: 50 * 500 = 25k users
    const result = await runBtp(
      ['get', 'security/role-collection', name, '--show-user-assignments', '--page', String(page)],
      opts
    );
    if (!result.ok) throw new Error(`btp get role-collection "${name}" page ${page} failed: ${result.stderr}`);
    const users = result.data?.userReferences || [];
    all.push(...users.map(u => ({ user: u.name || u.user, origin: u.origin || 'sap.default' })));
    if (users.length < 500) break;
  }
  return all;
}

/** Assign one user. Distinguishes "ok", "already" (idempotent re-assign), "failed". */
export async function assignUser(roleCollection, user, origin, opts = {}) {
  const result = await runBtp(
    [
      'assign', 'security/role-collection', roleCollection,
      '--to-user', user,
      '--of-idp', origin,
      '--create-user-if-missing', 'false',
    ],
    opts
  );
  if (result.ok) return { status: 'ok', message: result.raw.trim() };

  // Defensive: the CLI is supposed to return OK for already-assigned, but
  // if a future version regresses we want to recognize that case as success.
  const msg = `${result.stderr} ${result.raw}`.toLowerCase();
  if (msg.includes('already') || msg.includes('exists')) {
    return { status: 'already', message: result.stderr || result.raw };
  }
  return { status: 'failed', message: result.stderr || result.raw, exitCode: result.exitCode };
}
```

- [ ] **Step 1.8: Add tests for each new helper**

Append three more `it()` blocks to `btp-cli.test.ts`, one per helper, each using `FAKE_BTP_RESPONSE` to feed canned JSON. For `getRoleCollectionUsers`, include a multi-page test (page 1 returns 500 users, page 2 returns 3 — assert all 503 are returned and only 2 calls were made by checking the trace file). For `assignUser`, include an "already-assigned" stderr test asserting `status === 'already'`.

- [ ] **Step 1.9: Run all tests in the file**

```bash
npx vitest run scripts/__tests__/btp-cli.test.ts
```

Expected: PASS (~5 tests).

- [ ] **Step 1.10: Commit**

```bash
git add scripts/lib/btp-cli.js scripts/__tests__/btp-cli.test.ts scripts/__tests__/fixtures/fake-btp.cjs
git commit -m "feat(migrate-btp-roles): subprocess helper for btp CLI

Single-purpose wrapper around \`btp --format json\` with timeout, stderr
capture, and a BTP_BIN seam for tests. Helpers for the four CLI calls
the migration script needs: target, list, get-with-assignments, assign.

Refs spec: docs/superpowers/specs/2026-06-17-btp-role-migration-design.md"
```

---

## Task 2: `export` subcommand

Reads from the source subaccount (whatever `btp target` is at), writes the JSON the import step consumes.

**Files:**

- Create: `scripts/migrate-btp-roles.js`
- Modify: `scripts/__tests__/migrate-btp-roles.test.ts` (created here; tests for import/verify added in later tasks)

- [ ] **Step 2.1: Stub the script with subcommand dispatch and the role-collection map**

`scripts/migrate-btp-roles.js`:

```js
#!/usr/bin/env node
/**
 * Migrate BTP role-collection user assignments from one subaccount to another.
 * See docs/developers/operations/btp-role-migration.md for the runbook.
 *
 * Subcommands:
 *   export                 Read the active subaccount → .migration-data/btp-roles.json
 *   import --dry-run       Preview what would be written to the active subaccount
 *   import --confirm       Actually call `btp assign ...` per assignment
 *   verify                 Re-read active subaccount, diff against the export
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  getCurrentTarget,
  listRoleCollections,
  getRoleCollectionUsers,
  assignUser,
} from './lib/btp-cli.js';

// IMS Prod role collection name → new tutorial-system role collection name.
// Filled in after the first `export` run reveals the actual IMS-side names.
// The `export` subcommand will fail loudly if any source collection is not
// listed here (or in SKIP_BUILTIN_PREFIXES below), which is the intended
// discover-first behavior.
export const ROLE_COLLECTION_MAP = {
  // 'IMS Admin':         'Tutorials Admin',
  // 'IMS SuperAdmin':    'Tutorials SuperAdmin',
  // 'IMS ContentAuthor': 'Tutorials Author',
  // 'IMS Developer':     'Tutorials Developer',
  // 'IMS Display':       'Tutorials Display',
  // 'IMS Scanner':       'Tutorials Scanner',
};

// Built-in BTP role collections — never copied. They're pre-provisioned by
// the new global account and managed independently.
export const SKIP_BUILTIN_PREFIXES = [
  'Subaccount ',
  'Cloud Connector ',
  'Connectivity ',
  'Destination ',
];

const OUTPUT_FILE = process.env.BTP_ROLES_OUTPUT || '.migration-data/btp-roles.json';
const IMPORT_LOG = process.env.BTP_ROLES_IMPORT_LOG || '.migration-data/btp-roles-import.log.json';

function isBuiltin(name) {
  return SKIP_BUILTIN_PREFIXES.some(p => name.startsWith(p));
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'export': return await runExport();
    case 'import': return await runImport();
    case 'verify': return await runVerify();
    default:
      console.error('Usage: migrate-btp-roles.js <export|import|verify> [flags]');
      process.exit(2);
  }
}

// Stubs filled in by later steps:
async function runExport() { throw new Error('not implemented'); }
async function runImport() { throw new Error('not implemented'); }
async function runVerify() { throw new Error('not implemented'); }

// Allow `import` from tests without auto-running main().
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate-btp-roles.js');
if (invokedDirectly) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}
```

- [ ] **Step 2.2: Write the failing test for `runExport` happy path**

`scripts/__tests__/migrate-btp-roles.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BTP = join(HERE, 'fixtures', 'fake-btp.cjs');
const SCRIPT = join(HERE, '..', 'migrate-btp-roles.js');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'btp-roles-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runScript(args: string[], extraEnv: Record<string,string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    env: {
      ...process.env,
      BTP_BIN: process.execPath,
      // We can't pass btpBinArgs through env; instead the script's runBtp call
      // will use BTP_BIN (= node) and we trust the fake-btp dispatch via a
      // wrapper script. See Step 2.3 for how this is reconciled.
      BTP_ROLES_OUTPUT: join(work, 'btp-roles.json'),
      BTP_ROLES_IMPORT_LOG: join(work, 'btp-roles-import.log.json'),
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

describe('migrate-btp-roles export', () => {
  it('writes the expected JSON shape with mapped collections only', async () => {
    // Test asserts: discovers 1 mapped collection + 1 unmapped + 1 builtin,
    //   exits 0, output JSON has roleCollections=[mapped], discoveredButUnmapped=[unmapped],
    //   skippedBuiltins=[builtin].
    // Implementation in Step 2.4.
    expect(true).toBe(true);  // placeholder
  });
});
```

This first commit defines the test harness shape; we'll fill in the assertions once the export logic exists.

- [ ] **Step 2.3: Resolve the `BTP_BIN` indirection for E2E tests**

The `runBtp` helper accepts `btpBinArgs` in code, but child processes invoked via `spawnSync` only get env vars. Add a tiny shim env var to `btp-cli.js`:

```js
// At top of runBtp(), after computing `bin`:
const envBinArgs = process.env.BTP_BIN_ARGS ? [process.env.BTP_BIN_ARGS] : [];
const prefix = opts.btpBinArgs || envBinArgs;
```

`BTP_BIN_ARGS` carries exactly one path (always the fake-btp wrapper script). Tests do `BTP_BIN=node BTP_BIN_ARGS=<absolute-path-to-fake-btp.cjs>` and the script invokes `node fake-btp.cjs <real-args> --format json`. We don't need a multi-arg shape; if that ever becomes useful, switch to `\x1f` (ASCII unit-separator) split, but YAGNI.

Update `btp-cli.test.ts` to also exercise the env-var path with one assertion.

- [ ] **Step 2.4: Implement `runExport`**

Replace the stub in `scripts/migrate-btp-roles.js`:

```js
async function runExport() {
  const target = await getCurrentTarget();
  if (!target.subaccountId) {
    console.error('Could not determine current btp target. Run `btp login` and `btp target -sa <id>` first.');
    process.exit(1);
  }

  const collections = await listRoleCollections();

  const exported = [];
  const discoveredButUnmapped = [];
  const skippedBuiltins = [];

  for (const rc of collections) {
    const name = rc.name;
    if (isBuiltin(name)) { skippedBuiltins.push(name); continue; }
    if (!(name in ROLE_COLLECTION_MAP)) { discoveredButUnmapped.push(name); continue; }
    const users = await getRoleCollectionUsers(name);
    exported.push({
      sourceName: name,
      description: rc.description || '',
      users,
    });
  }

  const out = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      globalAccount: target.globalAccountSubdomain,
      subaccountId: target.subaccountId,
      subaccountSubdomain: target.subaccountSubdomain,
    },
    roleCollections: exported,
    discoveredButUnmapped,
    skippedBuiltins,
  };

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  const totalAssignments = exported.reduce((n, c) => n + c.users.length, 0);
  console.log(`Exported ${exported.length} mapped collections (${totalAssignments} assignments) → ${OUTPUT_FILE}`);
  if (discoveredButUnmapped.length > 0) {
    console.log(`\n${discoveredButUnmapped.length} discovered but UNMAPPED — add to ROLE_COLLECTION_MAP:`);
    for (const n of discoveredButUnmapped) console.log(`  - ${n}`);
    console.log('\nNote: --show-user-assignments only shows DIRECTLY assigned users.');
    console.log('Group/attribute-mapped role collections need separate handling.');
  }
  if (skippedBuiltins.length > 0) {
    console.log(`\nSkipped ${skippedBuiltins.length} built-in BTP collections.`);
  }
}
```

- [ ] **Step 2.5: Fill in the export test assertions**

Replace the placeholder in `migrate-btp-roles.test.ts`:

```ts
it('writes the expected JSON shape with mapped collections only', () => {
  // fake-btp will be called multiple times; respond by stubbing a single
  // fixture file that fake-btp keys on the joined argv. Simpler: run a
  // wrapper that picks responses from a JSON map.
  // For this round, stub via a per-call wrapper that snapshots argv.
  // (See fixtures/fake-btp-multi.cjs — created in this step.)
  // Assertions:
  const result = runScript(['export'], {
    BTP_BIN_ARGS: FAKE_BTP_MULTI,
    FAKE_BTP_FIXTURE_FILE: fixturePath,  // built in this test
  });
  expect(result.status).toBe(0);
  const out = JSON.parse(readFileSync(join(work, 'btp-roles.json'), 'utf8'));
  expect(out.roleCollections).toHaveLength(1);
  expect(out.roleCollections[0].sourceName).toBe('IMS Admin');
  expect(out.roleCollections[0].users).toEqual([
    { user: 'admin1@sap.com', origin: 'sap.default' },
  ]);
  expect(out.discoveredButUnmapped).toEqual(['Some Other Collection']);
  expect(out.skippedBuiltins).toEqual(['Subaccount Administrator']);
});
```

This requires a slightly smarter fake-btp than the one in Task 1. Add `scripts/__tests__/fixtures/fake-btp-multi.cjs`:

```js
// Reads a JSON fixture file (FAKE_BTP_FIXTURE_FILE) keyed by the joined argv
// (excluding --format json), responds with that entry's `stdout`/`exit`/`stderr`.
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2).filter(a => a !== '--format' && a !== 'json');
const key = args.join(' ');
const map = JSON.parse(fs.readFileSync(process.env.FAKE_BTP_FIXTURE_FILE, 'utf8'));
const entry = map[key] || map['_default'] || { stdout: '', exit: 1, stderr: `no fixture for: ${key}` };
if (entry.stderr) process.stderr.write(entry.stderr);
if (entry.stdout) process.stdout.write(typeof entry.stdout === 'string' ? entry.stdout : JSON.stringify(entry.stdout));
process.exit(entry.exit ?? 0);
```

The test builds the fixture map in-line: keys are `target`, `list security/role-collection`, `get security/role-collection IMS Admin --show-user-assignments --page 1`. Fill `ROLE_COLLECTION_MAP` for the test by `vi.mock`-ing the script — or simpler: also export `ROLE_COLLECTION_MAP` and seed it via a side-channel in the test. Since the script reads it at module top, the cleanest path is letting tests set `ROLE_COLLECTION_MAP` via env: add `BTP_ROLES_MAP_OVERRIDE` (JSON) read at module load:

```js
// In migrate-btp-roles.js, replace the const declaration:
export const ROLE_COLLECTION_MAP = process.env.BTP_ROLES_MAP_OVERRIDE
  ? JSON.parse(process.env.BTP_ROLES_MAP_OVERRIDE)
  : {
      // Filled in after first export run.
    };
```

Document the override in a code comment as TEST-ONLY.

- [ ] **Step 2.6: Run the export tests**

```bash
npx vitest run scripts/__tests__/migrate-btp-roles.test.ts
```

Expected: PASS (1 test). If JSON shape mismatches: fix the `runExport` output structure to match the spec.

- [ ] **Step 2.7: Add a failing-target test**

```ts
it('exits 1 when btp target has no subaccount', () => {
  const fixture = { 'target': { stdout: JSON.stringify({}), exit: 0 } };
  const result = runScript(['export'], { /* ...fixture wiring... */ });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Could not determine current btp target');
});
```

Run; expected: PASS (no code change needed — the guard already exists).

- [ ] **Step 2.8: Add `.migration-data/` to .gitignore (if not already)**

Verify with `grep -F '.migration-data/' .gitignore`. Already present per project context (`.tutorial-cache/`, `.tutorial-cache-qa/`, `.migration-data/`). No change needed; this step is a verification gate.

- [ ] **Step 2.9: Commit**

```bash
git add scripts/migrate-btp-roles.js scripts/__tests__/migrate-btp-roles.test.ts scripts/__tests__/fixtures/fake-btp-multi.cjs scripts/lib/btp-cli.js
git commit -m "feat(migrate-btp-roles): export subcommand

Reads the active subaccount via \`btp\` CLI, writes
.migration-data/btp-roles.json with mapped collections + their direct
user assignments. Discovers unmapped collections and exits with a clear
message rather than guessing.

Refs spec: docs/superpowers/specs/2026-06-17-btp-role-migration-design.md"
```

---

## Task 3: `import` subcommand

Reads `.migration-data/btp-roles.json` and writes to the *target* subaccount via `btp assign`. Pre-flight checks gate everything; per-assignment failures are logged but don't halt the run.

**Files:**

- Modify: `scripts/migrate-btp-roles.js` (replace `runImport` stub, add `--dry-run` / `--confirm` flag parsing, add per-assignment loop + log writer)
- Modify: `scripts/__tests__/migrate-btp-roles.test.ts` (add `describe('import', …)` block)

- [ ] **Step 3.1: Parse `--dry-run` / `--confirm` flags**

Add a small flag-parse helper at the top of `migrate-btp-roles.js`:

```js
function parseImportFlags(argv) {
  const dryRun = argv.includes('--dry-run');
  const confirm = argv.includes('--confirm');
  if (dryRun && confirm) {
    console.error('Pass either --dry-run or --confirm, not both.');
    process.exit(2);
  }
  if (!dryRun && !confirm) {
    console.error('Pass --dry-run to preview, or --confirm to actually write.');
    process.exit(2);
  }
  return { dryRun, confirm };
}
```

- [ ] **Step 3.2: Test that import without a flag exits 2**

Append to `migrate-btp-roles.test.ts`:

```ts
describe('migrate-btp-roles import', () => {
  it('exits 2 when neither --dry-run nor --confirm is passed', () => {
    // Need an export file to exist (later pre-flight checks for it), so
    // pre-write a minimal one even though the flag check fires first.
    mkdirSync(join(work, '.migration-data'), { recursive: true });
    writeFileSync(join(work, '.migration-data', 'btp-roles.json'),
      JSON.stringify({ schemaVersion:1, source:{subaccountId:'a'}, roleCollections:[] }));
    const result = runScript(['import']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--dry-run');
  });
});
```

Run `npx vitest run scripts/__tests__/migrate-btp-roles.test.ts -t 'exits 2 when neither'`. Expected: PASS once Step 3.1 is in place.

- [ ] **Step 3.3: Implement pre-flight checks**

Replace the `runImport` stub:

```js
async function runImport() {
  const flags = parseImportFlags(process.argv);

  // 1. Export file exists.
  if (!existsSync(OUTPUT_FILE)) {
    console.error(`Export file not found: ${OUTPUT_FILE}\nRun 'export' against the source subaccount first.`);
    process.exit(1);
  }
  const exportDoc = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));

  // 2. Current btp target.
  const target = await getCurrentTarget();
  if (!target.subaccountId) {
    console.error('Could not determine current btp target. Run `btp login` and `btp target -sa <id>` first.');
    process.exit(1);
  }

  // 3. Source != target. Re-targeting safety belt.
  if (target.subaccountId === exportDoc.source?.subaccountId) {
    console.error(
      `Refusing to import: target subaccount equals source subaccount (${target.subaccountId}).\n` +
      `You're connected to the same subaccount the export came from. Re-target with \`btp target -sa <new-id>\`.`
    );
    process.exit(1);
  }

  // 4. Every mapped target collection exists on the target subaccount.
  const targetCollections = await listRoleCollections();
  const targetNames = new Set(targetCollections.map(c => c.name));
  const missing = [];
  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    if (!targetName) {
      console.error(`Export contains "${rc.sourceName}" but ROLE_COLLECTION_MAP has no entry. Did the script change after export?`);
      process.exit(1);
    }
    if (!targetNames.has(targetName)) missing.push(targetName);
  }
  if (missing.length > 0) {
    console.error(`Target subaccount is missing these mapped role collections:\n  - ${missing.join('\n  - ')}\nDeploy xs-security.json or fix the mapping table.`);
    process.exit(1);
  }

  // ...assignment loop in next step
  await runAssignmentLoop(exportDoc, target, flags);
}
```

- [ ] **Step 3.4: Test the source==target guard**

```ts
it('refuses to import when target subaccount equals source', () => {
  // pre-write export pointing source.subaccountId = 'sub-1'
  // fixture: target returns { subaccountId: 'sub-1' }
  // assert exit 1, stderr contains 'target subaccount equals source'
});
```

Run; expected: PASS.

- [ ] **Step 3.5: Test missing-target-collection pre-flight**

```ts
it('exits 1 when a mapped target collection does not exist on target', () => {
  // export with one mapped collection, target list returns empty
  // BTP_ROLES_MAP_OVERRIDE includes the mapping
  // assert exit 1, stderr lists the missing collection
});
```

Run; expected: PASS.

- [ ] **Step 3.6: Implement the assignment loop**

Add to `migrate-btp-roles.js`:

```js
async function runAssignmentLoop(exportDoc, target, flags) {
  const log = [];
  let okCount = 0, alreadyCount = 0, failCount = 0;

  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    for (const { user, origin } of rc.users) {
      if (flags.dryRun) {
        console.log(`[dry-run] would assign "${targetName}" to ${user} (origin=${origin})`);
        log.push({ collection: targetName, user, origin, status: 'dry-run' });
        continue;
      }
      const result = await assignUser(targetName, user, origin);
      log.push({ collection: targetName, user, origin, status: result.status, message: result.message });
      if (result.status === 'ok')      { okCount++;      console.log(`[ok]      ${targetName} ← ${user}`); }
      else if (result.status === 'already') { alreadyCount++; console.log(`[already] ${targetName} ← ${user}`); }
      else                              { failCount++;    console.error(`[FAIL]    ${targetName} ← ${user}: ${result.message}`); }
      // Be polite to the BTP control plane.
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Summary + log file.
  mkdirSync(dirname(IMPORT_LOG), { recursive: true });
  writeFileSync(IMPORT_LOG, JSON.stringify({
    importedAt: new Date().toISOString(),
    target: { subaccountId: target.subaccountId, subaccountSubdomain: target.subaccountSubdomain },
    flags,
    summary: { ok: okCount, already: alreadyCount, failed: failCount },
    entries: log,
  }, null, 2));

  console.log(`\nImport summary (target subaccount: ${target.subaccountSubdomain || target.subaccountId})`);
  console.log(`  Collections processed: ${exportDoc.roleCollections.length}`);
  if (flags.dryRun) {
    console.log(`  Dry-run lines:         ${log.length}`);
  } else {
    console.log(`  Assignments OK:        ${okCount}`);
    console.log(`  Already-assigned:      ${alreadyCount}`);
    console.log(`  Failed:                ${failCount}`);
    if (failCount > 0) console.log(`  See log: ${IMPORT_LOG}`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}
```

- [ ] **Step 3.7: Test dry-run prints `[dry-run]` lines and makes no `assign` calls**

```ts
it('dry-run logs all assignments without calling btp assign', () => {
  // Fixture map provides target + list-role-collection responses, but
  // an `assign ...` key with exit:1 + 'should not be called' stderr.
  // BTP_ROLES_MAP_OVERRIDE = {"IMS Admin":"Tutorials Admin"}
  // Pre-written export with 2 users.
  const result = runScript(['import', '--dry-run'], { /* fixture wiring */ });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/\[dry-run\] would assign "Tutorials Admin" to user1@sap\.com/);
  expect(result.stdout).toMatch(/\[dry-run\] would assign "Tutorials Admin" to user2@sap\.com/);
  // Trace file should NOT contain any 'assign' invocation.
  const trace = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  expect(trace.find(args => args.includes('assign'))).toBeUndefined();
});
```

Run; expected: PASS.

- [ ] **Step 3.8: Test `--confirm` end-to-end with mixed ok/already/failed**

```ts
it('--confirm tallies ok/already/failed correctly and exits 1 on any fail', () => {
  // Fixture: 3 users, 3 distinct `assign` responses keyed on user email
  //   user1: exit 0, stdout 'OK'
  //   user2: exit 1, stderr 'already assigned'
  //   user3: exit 1, stderr 'user not found in IDP'
  const result = runScript(['import', '--confirm'], { /* fixture wiring */ });
  expect(result.status).toBe(1);
  const log = JSON.parse(readFileSync(join(work, '.migration-data', 'btp-roles-import.log.json'), 'utf-8'));
  expect(log.summary).toEqual({ ok: 1, already: 1, failed: 1 });
  expect(log.entries.find(e => e.user === 'user3@sap.com').status).toBe('failed');
});
```

Run; expected: PASS.

- [ ] **Step 3.9: Run all tests, then commit**

```bash
npx vitest run scripts/__tests__/migrate-btp-roles.test.ts
git add scripts/migrate-btp-roles.js scripts/__tests__/migrate-btp-roles.test.ts
git commit -m "feat(migrate-btp-roles): import subcommand with dry-run + confirm

Pre-flight checks (export file present, btp target valid, source!=target,
mapped target collections exist) all gate the run with exit 1. Per-user
loop calls \`btp assign\` and tallies ok/already/failed; exit 1 if any
failed. 100 ms throttle between calls. Writes
.migration-data/btp-roles-import.log.json with the full per-call result.

Refs spec: docs/superpowers/specs/2026-06-17-btp-role-migration-design.md"
```

---

## Task 4: `verify` subcommand

Read-only diff between the source export and the current state of the target subaccount. Same export logic, just diffed instead of written.

**Files:**

- Modify: `scripts/migrate-btp-roles.js` (replace `runVerify` stub)
- Modify: `scripts/__tests__/migrate-btp-roles.test.ts` (add `describe('verify', …)` block)

- [ ] **Step 4.1: Implement `runVerify`**

```js
async function runVerify() {
  if (!existsSync(OUTPUT_FILE)) {
    console.error(`Export file not found: ${OUTPUT_FILE}`);
    process.exit(1);
  }
  const exportDoc = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));

  const target = await getCurrentTarget();
  if (target.subaccountId === exportDoc.source?.subaccountId) {
    console.error(`Refusing to verify: btp target points at the source subaccount, not the import target.`);
    process.exit(1);
  }

  let totalMissing = 0, totalExtra = 0;
  for (const rc of exportDoc.roleCollections) {
    const targetName = ROLE_COLLECTION_MAP[rc.sourceName];
    if (!targetName) continue;

    const targetUsers = await getRoleCollectionUsers(targetName);
    const expected = new Set(rc.users.map(u => `${u.user}|${u.origin}`));
    const actual   = new Set(targetUsers.map(u => `${u.user}|${u.origin}`));

    const missing = [...expected].filter(k => !actual.has(k));
    const extra   = [...actual].filter(k => !expected.has(k));

    console.log(`\n${targetName}`);
    console.log(`  expected ${expected.size}, found ${actual.size}, missing ${missing.length}, extra ${extra.length}`);
    for (const k of missing) console.log(`    [missing] ${k}`);
    for (const k of extra)   console.log(`    [extra]   ${k}`);

    totalMissing += missing.length;
    totalExtra   += extra.length;
  }

  console.log(`\nVerify summary: ${totalMissing} missing, ${totalExtra} extra`);
  process.exit(totalMissing > 0 ? 1 : 0);
}
```

Note: "extra" entries are reported as info-only — pre-existing assignments on the target are normal and not a failure. Only "missing" influences exit code.

- [ ] **Step 4.2: Test verify happy path (everything matches → exit 0)**

```ts
it('verify reports zero missing/extra and exits 0 when target matches export', () => {
  // Pre-write export with 1 collection / 2 users.
  // Fixture: target's get-role-collection returns those same 2 users.
  // BTP_ROLES_MAP_OVERRIDE = {"IMS Admin":"Tutorials Admin"}
  const result = runScript(['verify'], { /* fixture wiring */ });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/expected 2, found 2, missing 0, extra 0/);
});
```

- [ ] **Step 4.3: Test verify reports missing users and exits 1**

```ts
it('verify exits 1 when target is missing a user from export', () => {
  // Export has 2 users; target only has 1.
  const result = runScript(['verify'], { /* fixture wiring */ });
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/\[missing\] missing-user@sap\.com\|sap\.default/);
});
```

- [ ] **Step 4.4: Test verify treats "extra" users as informational (exit 0 if no missing)**

```ts
it('verify exits 0 even when target has extra users not in export', () => {
  // Export has 1 user; target has 2.
  const result = runScript(['verify'], { /* fixture wiring */ });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/\[extra\] extra-user@sap\.com/);
});
```

- [ ] **Step 4.5: Run tests and commit**

```bash
npx vitest run scripts/__tests__/migrate-btp-roles.test.ts
git add scripts/migrate-btp-roles.js scripts/__tests__/migrate-btp-roles.test.ts
git commit -m "feat(migrate-btp-roles): verify subcommand

Diff the export against the live target subaccount. Reports per-collection
missing/extra. Missing → exit 1; extra alone → exit 0 (pre-existing
assignments on the target are normal). Refuses to run if btp target
points at the source subaccount.

Refs spec: docs/superpowers/specs/2026-06-17-btp-role-migration-design.md"
```

---

## Task 5: Runbook, sidebar, package.json, CLAUDE.md

Operator-facing documentation and the npm-script alias. No code changes.

**Files:**

- Create: `docs/developers/operations/btp-role-migration.md`
- Modify: `docs/.vitepress/config.ts` (sidebar entry, alphabetic position)
- Modify: `CLAUDE.md` (one-line mention under "Data Migration")
- Modify: `package.json` (add `migrate:btp-roles` script alias)

- [ ] **Step 5.1: Write the runbook**

`docs/developers/operations/btp-role-migration.md`:

```markdown
# BTP role-collection migration

One-shot operator runbook: copy BTP role-collection user assignments from the legacy IMS Prod subaccount to the new tutorial-system subaccount.

## When to run

After a fresh deploy of the new subaccount has provisioned the empty role collections (`Tutorials Admin`, `Tutorials SuperAdmin`, etc.), but before tutorial admins/authors need to log in. The data-layer migration (tutorials, missions, user progress) can run before, after, or in parallel — it's independent.

## Prerequisites

- `btp` CLI v2.97.0+ (`btp --version`).
- Logged into both global accounts (one at a time): `btp login`.
- Read access on the IMS Prod subaccount (you need to be able to call `btp get security/role-collection NAME --show-user-assignments`).
- Write access on the tutorial-system subaccount (Subaccount Administrator or equivalent).

## Phase 1 — Discover

First export reveals the actual IMS-side collection names. The script ships with an empty `ROLE_COLLECTION_MAP`; this run tells you what to put in it.

```bash
btp login                                            # → IMS Prod global account
btp target -sa <ims-prod-subaccount-id>              # → IMS Prod subaccount
npm run migrate:btp-roles -- export
```

Output will list `discoveredButUnmapped: [...]` — every IMS Prod role collection that has no entry in the mapping. Edit `scripts/migrate-btp-roles.js` to fill in the `ROLE_COLLECTION_MAP` constant for each, commit, push.

## Phase 2 — Export

Re-run with the populated mapping:

```bash
npm run migrate:btp-roles -- export
```

Eyeball `.migration-data/btp-roles.json`. Confirm:

- `source.subaccountId` matches the IMS Prod subaccount.
- Every expected role collection appears in `roleCollections`.
- `discoveredButUnmapped` is `[]` (or contains only collections you genuinely don't want to migrate).

## Phase 3 — Dry-run import

```bash
btp login                                            # → DevRel & Community Tools GA
btp target -sa <tutorial-system-subaccount-id>       # → tutorial-system subaccount
npm run migrate:btp-roles -- import --dry-run
```

Review the `[dry-run] would assign ...` lines. Every line you'd expect to see should be there.

## Phase 4 — Real import

```bash
npm run migrate:btp-roles -- import --confirm
```

Watch for `[FAIL]` lines. Failed assignments are also logged to `.migration-data/btp-roles-import.log.json`. Common failures:

| Message | Cause | Fix |
|---|---|---|
| `user not found in IDP` | The user has never logged into the new GA's IDP, and `--create-user-if-missing false` blocks shadow creation. | Have the user log in once (creates the shadow), then re-run. Re-run is idempotent. |
| `role collection not found` | Mapping table targets a collection that hasn't been deployed yet. | Run the MTA deploy or fix the mapping. |

## Phase 5 — Verify

```bash
npm run migrate:btp-roles -- verify
```

`Verify summary: 0 missing, N extra` is the success state. Non-zero "missing" → re-run `import --confirm` to retry, or address the underlying issue.

## Caveats

- `--show-user-assignments` only sees **directly-assigned** users. Group/attribute-mapped assignments do not appear in the export and need separate handling. (We don't believe IMS Prod uses any.)
- Audit trail on the new subaccount will record "migrated by <Tom> at <date>" for every assignment, not the original assignor. Acceptable for a cutover.
- IDP origin is preserved verbatim. Both subaccounts are expected to trust the same SAP IAS tenant on the same `--of-idp` origin. If that ever changes, add an origin-mapping step.

## Related

- Spec: [2026-06-17-btp-role-migration-design.md](../../superpowers/specs/2026-06-17-btp-role-migration-design.md)
- Sibling data-migration scripts: `migrate-reference-data.js`, `migrate-user-progress.js`
```

- [ ] **Step 5.2: Add the sidebar entry**

`docs/.vitepress/config.ts` — within `themeConfig.sidebar` → `Operations` items array, insert alphabetically (between `A/B comparison runbook` and `AI-author CI setup`):

```ts
{ text: 'BTP role migration',        link: '/developers/operations/btp-role-migration' },
```

The `predocs:build` guard rejects any operations page that is not registered; `npm run docs:build` will pass after this entry is added.

- [ ] **Step 5.3: Add `npm run` alias**

`package.json` — add to `scripts` block (alphabetical with the other `migrate:` entries):

```json
"migrate:btp-roles": "node scripts/migrate-btp-roles.js"
```

Smoke test:

```bash
npm run migrate:btp-roles -- --help 2>&1 | head -3
```

(The script doesn't have `--help`; it should print the `Usage:` line from the default switch case and exit 2. That confirms wiring.)

- [ ] **Step 5.4: Mention in CLAUDE.md**

`CLAUDE.md` — under the existing "Data Migration" subsection (the paragraph that lists `migrate-reference-data.js`, `migrate-user-progress.js`, etc.), add one line:

```markdown
- `migrate-btp-roles.js` — copy BTP role-collection user assignments from a source subaccount to the current target. See [docs/developers/operations/btp-role-migration.md](docs/developers/operations/btp-role-migration.md).
```

- [ ] **Step 5.5: Run the docs build to verify**

```bash
npm run docs:build
```

Expected: passes the `predocs:build` sidebar guard and emits no broken-link warnings for the new page.

- [ ] **Step 5.6: Commit**

```bash
git add docs/developers/operations/btp-role-migration.md docs/.vitepress/config.ts CLAUDE.md package.json
git commit -m "docs(migrate-btp-roles): operator runbook + sidebar + npm alias

Operator runbook covers the discover-first export → fill-mapping → dry-run
→ confirm → verify cadence. Sidebar entry registered with predocs:build.
npm run alias added alongside the existing migrate:* scripts.

Refs spec: docs/superpowers/specs/2026-06-17-btp-role-migration-design.md"
```

---

## Final acceptance

- [ ] All Vitest tests in `scripts/__tests__/btp-cli.test.ts` and `scripts/__tests__/migrate-btp-roles.test.ts` pass.
- [ ] `npm test` passes (no regressions in existing scripts test suite).
- [ ] `npm run docs:build` passes.
- [ ] Manual smoke (Tom, against real BTP):
  1. `btp login` → IMS Prod GA → `npm run migrate:btp-roles -- export` against IMS Prod subaccount.
  2. Eyeball `.migration-data/btp-roles.json`, fill `ROLE_COLLECTION_MAP`, commit, push, repeat export.
  3. `btp login` → DevRel GA → `npm run migrate:btp-roles -- import --dry-run` against tutorial-system → eyeball.
  4. `npm run migrate:btp-roles -- import --confirm`.
  5. `npm run migrate:btp-roles -- verify` → expect `0 missing`.

## Notes & deferred items

- **Group/attribute-mapped assignments are out of scope.** If `discoveredButUnmapped` is empty after the first export but post-cutover users complain they can't reach `/admin-ui/`, suspect IDP-group mapping and handle separately.
- **No automatic rollback.** If the import lands on the wrong subaccount, reversal is `btp unassign security/role-collection ... --to-user ...` per row of `.migration-data/btp-roles-import.log.json`. Build a `rollback` subcommand only if it ever actually happens.
- **Audit log.** BTP records the import as performed by whoever ran `--confirm`, not the original assignor. Documented in the runbook caveat section.

