// Single-purpose helper around the `btp` CLI subprocess. Every caller goes
// through runBtp() so we have one place to inject --format json, capture
// stderr, enforce timeouts, and swap the binary for tests via BTP_BIN.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;

// Paging hard cap: BTP_PAGE_SIZE * MAX_PAGES = 25k users per role collection,
// well above realistic tenant scale.
const BTP_PAGE_SIZE = 500;
const MAX_PAGES = 50;

// Matches the actual "user is already assigned/granted/a member of" vocabulary
// the CLI emits. Avoids false positives like "already deleted" or
// "role does not exist" being silently classified as success.
const ALREADY_ASSIGNED = /already\s+(assigned|a member|granted|has)|user\s+is\s+already|already\s+exists\s+as/i;

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
  const envBinArgs = process.env.BTP_BIN_ARGS ? [process.env.BTP_BIN_ARGS] : [];
  const prefix = opts.btpBinArgs || envBinArgs;
  // `--format json` is a btp CLI top-level OPTION, not a per-subcommand flag.
  // It MUST appear before the action keyword (e.g. `btp --format json list ...`).
  // Putting it at the end yields `Unknown parameter: --format` on most subcommands.
  const fullArgs = [...prefix, '--format', 'json', ...args];
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

/**
 * Read the active subaccount/global-account from the BTP CLI's config file.
 *
 * We can't shell out to `btp target` for this — bare `btp target` is
 * INTERACTIVE (prompts for a subaccount selection if not given a flag), and
 * even with `--format json` it rejects the flag (it's a top-level option, but
 * the `target` subcommand explicitly disallows JSON output). The CLI persists
 * its current target to `$APPDATA/SAP/btp/config.json` (Windows) or
 * `$HOME/.config/.btp/config.json` (POSIX) — the structured `TargetHierarchy`
 * field there is exactly what we need, and reading it directly avoids any
 * subprocess that might prompt or hang.
 *
 * TEST-ONLY: BTP_TARGET_OVERRIDE env var (JSON of the return value) short-circuits
 * the file read. Used by tests that spawn the script as a child process.
 */
export async function getCurrentTarget(opts = {}) {
  // opts kept for signature compatibility; this implementation doesn't shell out.
  void opts;

  if (process.env.BTP_TARGET_OVERRIDE) {
    try { return JSON.parse(process.env.BTP_TARGET_OVERRIDE); }
    catch (err) { throw new Error(`BTP_TARGET_OVERRIDE is not valid JSON: ${err.message}`); }
  }

  const candidates = [];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'SAP', 'btp', 'config.json'));
  if (process.env.HOME)    candidates.push(join(process.env.HOME, '.config', '.btp', 'config.json'));
  if (process.env.HOME)    candidates.push(join(process.env.HOME, '.btp', 'config.json'));

  let cfg;
  for (const path of candidates) {
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); break; }
    catch { /* try next */ }
  }
  if (!cfg) {
    throw new Error(`btp config file not found in any of: ${candidates.join(', ')}\nRun 'btp login' and 'btp target -sa <id>' first.`);
  }

  const hierarchy = cfg.TargetHierarchy || [];
  const ga  = hierarchy.find(t => t.Type === 'globalaccount');
  const sa  = hierarchy.find(t => t.Type === 'subaccount');
  return {
    subaccountId:           sa?.ID,
    subaccountSubdomain:    sa?.Subdomain,
    globalAccountSubdomain: ga?.Subdomain,
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
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await runBtp(
      ['get', 'security/role-collection', name, '--show-user-assignments', '--page', String(page)],
      opts
    );
    if (!result.ok) throw new Error(`btp get role-collection "${name}" page ${page} failed: ${result.stderr}`);
    // CLI shape varies: real BTP CLI v2.97 emits `{ items: [{username, origin, ...}], count, totalPages }`.
    // Older / mocked versions used `{ userReferences: [{name, origin}] }`. Accept both.
    const users = result.data?.items || result.data?.userReferences || [];
    all.push(...users.map(u => ({
      user: u.username || u.user || u.name,
      origin: u.origin || 'sap.default',
    })));
    if (users.length < BTP_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Assign one user. Distinguishes "ok", "already" (idempotent re-assign), "failed".
 *
 * @param {boolean} [opts.createUserIfMissing=false] when true, allows the BTP CLI
 *   to mint a shadow user if the email isn't in the target IDP yet. Default false
 *   (loud failure on typos); set true for cutover migrations where you want to
 *   pre-provision shadow users for people who haven't logged in yet.
 */
export async function assignUser(roleCollection, user, origin, opts = {}) {
  const createMissing = opts.createUserIfMissing === true ? 'true' : 'false';
  const result = await runBtp(
    [
      'assign', 'security/role-collection', roleCollection,
      '--to-user', user,
      '--of-idp', origin,
      '--create-user-if-missing', createMissing,
    ],
    opts
  );
  if (result.ok) return { status: 'ok', message: result.raw.trim() };

  // Defensive: the CLI is supposed to return OK for already-assigned, but
  // if a future version regresses we want to recognize that case as success.
  const msg = `${result.stderr} ${result.raw}`.toLowerCase();
  if (ALREADY_ASSIGNED.test(msg)) {
    return { status: 'already', message: result.stderr || result.raw };
  }
  return { status: 'failed', message: result.stderr || result.raw, exitCode: result.exitCode };
}
