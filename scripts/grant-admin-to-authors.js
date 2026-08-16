#!/usr/bin/env node
/**
 * Grant the Admin role collection to tutorial authors who lack it (#1837).
 *
 * WHY THIS EXISTS
 *   The Admin UI (AdminService) is `@requires: 'Admin'` at the service level
 *   (srv/admin-service.cds). CAP enforces that first for EVERY request —
 *   including `GET /admin/$metadata` — so a user holding only the
 *   `Tutorials Author` role collection (scopes: Tutorial.Author + Everyone,
 *   see xs-security.json) gets a 403 and the Author Console never loads.
 *   Author-console access requires the `Admin` scope, which the `Tutorials
 *   Admin` role collection grants. This is by design (admin-service.cds
 *   comment ~line 138: "A Tutorial.Author-only user (without Admin) cannot
 *   reach this service"). The fix is operational, not code: assign the
 *   affected authors the `Tutorials Admin` role collection.
 *
 *   This recurs (2026-07-23 PROD incident, then #1837), so this script makes
 *   the "who's missing Admin?" enumeration + the grant repeatable and safe.
 *
 * WHAT IT DOES
 *   1. Reads members of the Author role collection and the Admin role
 *      collection on the CURRENTLY-TARGETED subaccount.
 *   2. Computes the set difference (authors NOT already in Admin) — this is
 *      the "affected-user list".
 *   3. Dry-run by default: prints the list and makes ZERO changes.
 *      With --commit: assigns the Admin role collection to each, idempotently.
 *
 * SAFETY
 *   - Same-subaccount operation (both collections live in one XSUAA), so there
 *     is no source!=target belt like migrate-btp-roles.js. Instead it prints
 *     the resolved target and supports `--subaccount <subdomain>` as a sanity
 *     assertion (refuses to run if the live target doesn't match).
 *   - Dry-run is the default; you must pass --commit to mutate anything.
 *   - Idempotent: users already in Admin are reported "already", never
 *     re-written; a re-run after a partial failure is safe.
 *
 * USAGE
 *   # 1. Log in and target the RIGHT subaccount first:
 *   btp login
 *   btp target -sa 3c6fa3f1-db8c-4e47-9048-fa8c84b867cb   # Tutorial System
 *
 *   # 2. Preview the affected-user list (no changes) — DEV collections:
 *   node scripts/grant-admin-to-authors.js
 *
 *   # 3. PROD collections (the (Prod)-suffixed set) — preview:
 *   node scripts/grant-admin-to-authors.js --prod --subaccount tutorial-system
 *
 *   # 4. Grant Admin to a SINGLE named author (individual grant):
 *   node scripts/grant-admin-to-authors.js --prod --user someone@sap.com --commit
 *
 *   # 5. Grant Admin to ALL authors currently missing it (bulk):
 *   node scripts/grant-admin-to-authors.js --prod --subaccount tutorial-system --commit
 *
 * Flags:
 *   --prod                 Use the (Prod)-suffixed role collection names.
 *   --commit               Actually assign (default is dry-run / preview).
 *   --user <email>         Cherry-pick: grant Admin to just this user (skips
 *                          enumeration). Repeatable. Origin from --of-idp.
 *   --of-idp <origin>      IdP origin for --user grants (default sap.default).
 *   --exclude <email>      Omit this user from the enumerated grant (repeatable;
 *                          e.g. a group account). Applies to enumeration mode.
 *   --subaccount <subdom>  Assert the live btp target subdomain matches.
 *   --author-rc <name>     Override the Author role-collection name.
 *   --admin-rc <name>      Override the Admin role-collection name.
 *
 * Exit codes: 0 ok, 1 target/assignment failure, 2 bad arguments.
 */
import {
  assignUser,
  getCurrentTarget,
  getRoleCollectionUsers,
  listRoleCollections,
} from './lib/btp-cli.js';

// Be polite to the BTP control plane between assignment calls.
const THROTTLE_MS = 100;

function parseArgs(argv) {
  const flags = {
    prod: false,
    commit: false,
    users: [],
    excludes: [],
    ofIdp: 'sap.default',
    subaccount: null,
    authorRc: null,
    adminRc: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--prod':    flags.prod = true; break;
      case '--commit':  flags.commit = true; break;
      case '--user':    flags.users.push(requireValue(argv, ++i, a)); break;
      case '--exclude': flags.excludes.push(requireValue(argv, ++i, a)); break;
      case '--of-idp':  flags.ofIdp = requireValue(argv, ++i, a); break;
      case '--subaccount': flags.subaccount = requireValue(argv, ++i, a); break;
      case '--author-rc': flags.authorRc = requireValue(argv, ++i, a); break;
      case '--admin-rc':  flags.adminRc = requireValue(argv, ++i, a); break;
      case '--help': case '-h': flags.help = true; break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return flags;
}

function requireValue(argv, i, flag) {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${flag} requires a value.`);
    process.exit(2);
  }
  return v;
}

function resolveCollectionNames(flags) {
  const suffix = flags.prod ? ' (Prod)' : '';
  return {
    authorRc: flags.authorRc || `Tutorials Author${suffix}`,
    adminRc:  flags.adminRc  || `Tutorials Admin${suffix}`,
  };
}

const userKey = (u) => `${u.user}|${u.origin}`;

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log('See the header comment of this file for usage.');
    process.exit(0);
  }

  const { authorRc, adminRc } = resolveCollectionNames(flags);

  // 1. Resolve + report the target so the operator can confirm they're on the
  //    right subaccount BEFORE anything mutates (cf/btp target drift bites).
  const target = await getCurrentTarget();
  if (!target.subaccountId) {
    console.error('Could not determine current btp target. Run `btp login` and `btp target -sa <id>` first.');
    process.exit(1);
  }
  console.log(`Target subaccount: ${target.subaccountSubdomain || '(unknown subdomain)'} (${target.subaccountId})`);
  console.log(`Author collection: "${authorRc}"   Admin collection: "${adminRc}"`);
  console.log(`Mode: ${flags.commit ? 'COMMIT (will assign)' : 'DRY-RUN (no changes)'}\n`);

  if (flags.subaccount && target.subaccountSubdomain !== flags.subaccount) {
    console.error(
      `Refusing to run: live btp target subdomain is "${target.subaccountSubdomain}" ` +
      `but --subaccount expected "${flags.subaccount}". Re-target with \`btp target -sa <id>\`.`
    );
    process.exit(1);
  }

  // Sanity: both role collections must exist on the target.
  const existing = new Set((await listRoleCollections()).map(c => c.name));
  const missingRc = [authorRc, adminRc].filter(n => !existing.has(n));
  if (missingRc.length > 0) {
    console.error(
      `Target subaccount is missing role collection(s): ${missingRc.map(n => `"${n}"`).join(', ')}.\n` +
      `Are you on the right subaccount / did you mean --prod? Available (first 40):\n  - ` +
      [...existing].slice(0, 40).join('\n  - ')
    );
    process.exit(1);
  }

  // 2. Build the list of users to grant Admin to.
  let toGrant; // array of { user, origin }
  if (flags.users.length > 0) {
    // Cherry-pick mode: grant to exactly the named users (no enumeration).
    toGrant = flags.users.map(user => ({ user, origin: flags.ofIdp }));
    console.log(`Cherry-pick: ${toGrant.length} named user(s) → "${adminRc}"\n`);
  } else {
    const [authors, admins] = await Promise.all([
      getRoleCollectionUsers(authorRc),
      getRoleCollectionUsers(adminRc),
    ]);
    const adminKeys = new Set(admins.map(userKey));
    toGrant = authors.filter(a => !adminKeys.has(userKey(a)));

    // Drop explicitly excluded users (e.g. group accounts you don't want to
    // hand Admin to). Case-insensitive match on the email.
    if (flags.excludes.length > 0) {
      const excl = new Set(flags.excludes.map(e => e.toLowerCase()));
      const before = toGrant.length;
      const dropped = toGrant.filter(a => excl.has(a.user.toLowerCase()));
      toGrant = toGrant.filter(a => !excl.has(a.user.toLowerCase()));
      if (dropped.length > 0) {
        console.log(`Excluded ${before - toGrant.length} user(s) via --exclude: ` +
                    dropped.map(u => u.user).join(', '));
      }
    }

    console.log(`Authors: ${authors.length}   Admins: ${admins.length}   ` +
                `Authors WITHOUT Admin${flags.excludes.length ? ' (post-exclude)' : ''}: ${toGrant.length}\n`);
    if (toGrant.length === 0) {
      console.log('Nothing to do — every author already holds Admin.');
      process.exit(0);
    }
    console.log('Affected users (authors missing Admin):');
    for (const u of toGrant) console.log(`  - ${u.user} (origin=${u.origin})`);
    console.log('');
  }

  // 3. Dry-run stops here; commit performs the grants.
  if (!flags.commit) {
    console.log(`[dry-run] Would assign "${adminRc}" to ${toGrant.length} user(s). ` +
                `Re-run with --commit to apply.`);
    process.exit(0);
  }

  let ok = 0, already = 0, failed = 0;
  for (const { user, origin } of toGrant) {
    const result = await assignUser(adminRc, user, origin);
    if (result.status === 'ok')           { ok++;      console.log(`[ok]      ${adminRc} <- ${user}`); }
    else if (result.status === 'already') { already++; console.log(`[already] ${adminRc} <- ${user}`); }
    else                                  { failed++;  console.error(`[FAIL]    ${adminRc} <- ${user}: ${result.message}`); }
    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  console.log(`\nSummary: ${ok} assigned, ${already} already had it, ${failed} failed.`);
  console.log('Granted users must log out and back in to refresh their JWT.');
  process.exit(failed > 0 ? 1 : 0);
}

// Allow importing from tests without auto-running main(). On Windows the `===`
// comparison fails (backslash argv path vs forward-slash file:/// URL), so the
// endsWith() arm carries the load — same pattern as migrate-btp-roles.js.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('grant-admin-to-authors.js');
if (invokedDirectly) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}

export { parseArgs, resolveCollectionNames };
