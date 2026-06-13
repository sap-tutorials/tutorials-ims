// srv/lib/branch/profile-override.js
//
// Issue #172 PR 6 — Pilot enablement. Express-request override parser.
//
// Extracts a validated profile override from `?profile.<field>=<value>` query
// params on EXPRESS callsites only. Gated on Tutorial.Author OR Admin scope
// (round-1 pivot 2). Empty strings are dropped (treated same as missing).
//
// Invariant (architectural): this consumes the EXPRESS req — req.user, and
// req.query as flat string map. It is NOT for CAP action handlers; the
// chat-orchestrator and setLearningPreferences both receive a CAP req whose
// req.query is a CQN object, not an express query map. The override is
// request-time only on the two express callsites (decideHandler in
// srv/lib/branch/decide.js, missionDetailHandler in srv/lib/branch/mission-detail.js)
// and never persists.
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §3.6, §5.3, §7.3

import { PROFILE_FIELDS, PROFILE_VOCAB } from './profile-fields.js';

/**
 * Extract a validated profile override from an EXPRESS request.
 *
 * @param {object} req - express request object (has req.user.is(scope) + req.query)
 * @returns {object|null} { <field>: <value>, ... } when at least one valid
 *   override survives the gate + allowlist; null otherwise.
 */
export function extractProfileOverride(req) {
  const isAuthor = req?.user?.is?.('Tutorial.Author');
  const isAdmin = req?.user?.is?.('Admin');
  if (!isAuthor && !isAdmin) return null;
  const override = {};
  for (const field of PROFILE_FIELDS) {
    const v = req.query?.[`profile.${field}`];
    // Empty string treated same as missing — defence in depth + qs-parser fragility.
    if (typeof v === 'string' && v !== '' && PROFILE_VOCAB[field].includes(v)) {
      override[field] = v;
    }
  }
  return Object.keys(override).length ? override : null;
}
