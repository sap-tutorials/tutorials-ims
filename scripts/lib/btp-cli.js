// Single-purpose helper around the `btp` CLI subprocess. Every caller goes
// through runBtp() so we have one place to inject --format json, capture
// stderr, enforce timeouts, and swap the binary for tests via BTP_BIN.
import { spawn } from 'node:child_process';

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
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await runBtp(
      ['get', 'security/role-collection', name, '--show-user-assignments', '--page', String(page)],
      opts
    );
    if (!result.ok) throw new Error(`btp get role-collection "${name}" page ${page} failed: ${result.stderr}`);
    const users = result.data?.userReferences || [];
    all.push(...users.map(u => ({ user: u.name || u.user, origin: u.origin || 'sap.default' })));
    if (users.length < BTP_PAGE_SIZE) break;
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
  if (ALREADY_ASSIGNED.test(msg)) {
    return { status: 'already', message: result.stderr || result.raw };
  }
  return { status: 'failed', message: result.stderr || result.raw, exitCode: result.exitCode };
}
