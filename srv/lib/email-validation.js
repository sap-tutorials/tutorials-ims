// srv/lib/email-validation.js
//
// Email shape validation for the Advocate emailEdit feature. Centralized
// so the handler logic stays focused on the propagation flow.
//
// Returns:
//   { ok: true, value: '<normalized email>' }     on success
//   { ok: false, code: '<ERROR_CODE>' }           on rejection
//
// Error codes match the spec's §5 validation matrix:
//   EMAIL_REQUIRED  — null/undefined/empty/whitespace-only
//   EMAIL_INVALID   — fails RFC-5322 shape check
//   EMAIL_TOO_LONG  — exceeds 254 chars (max per RFC-5321)
//
// Normalization: trim, then lowercase. Note: the JWT-backfill path at
// srv/lib/resolve-db-user.js#backfillUserProfile writes the email claim
// verbatim (no case folding) — admin-entered values flow through this
// helper and get canonicalized; JIT-backfilled values do not. This is
// intentional: admin writes are the authoritative shape; JWT writes
// only fire when the column is null.

// Pragmatic RFC-5322 shape — same posture as srv/lib/feedback-salt.js etc.
// Requires: local@domain.tld with TLD length >= 2.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(input) {
  if (input == null || typeof input !== 'string') {
    return { ok: false, code: 'EMAIL_REQUIRED' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'EMAIL_REQUIRED' };
  }
  if (trimmed.length > 254) {
    return { ok: false, code: 'EMAIL_TOO_LONG' };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, code: 'EMAIL_INVALID' };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}
