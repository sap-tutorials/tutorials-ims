import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

// Task 23 (#600) — smoke test for the deployed /api/resetTutorialProgress
// action. Two tests:
//   1. Unauthenticated POST → 401/403 (always runs; proves the endpoint is
//      wired and auth-gated).
//   2. Authenticated POST → 200 with the documented response shape, OR 404
//      if the test slug isn't seeded in the target env (skip-if no token).
//
// The action is DESTRUCTIVE — it supersedes live TaskRecord rows for the
// caller. Use an opt-in test slug via SMOKE_RESET_SLUG (default
// `__SMOKE_TEST__-reset`) that's seeded for the SMOKE_AUTH_TOKEN user. If
// the slug doesn't exist the server returns 404 and the test asserts that
// gracefully, surfacing a console.warn so CI logs flag the missing seed
// without failing the run.
//
// Env vars:
//   SMOKE_SRV_URL          — CAP srv base URL (canonical, set by CI)
//   SMOKE_AUTH_TOKEN       — Bearer JWT for an authenticated user (optional)
//   SMOKE_RESET_SLUG       — slug to reset (default `__SMOKE_TEST__-reset`)

const TOKEN = process.env.SMOKE_AUTH_TOKEN;
const TEST_SLUG = process.env.SMOKE_RESET_SLUG || '__SMOKE_TEST__-reset';

describe.skipIf(!process.env.SMOKE_SRV_URL && !process.env.SMOKE_BASE_URL)(
  'resetTutorialProgress smoke (deployed)',
  () => {
    it('POST /api/resetTutorialProgress without auth returns 401/403', async () => {
      const res = await fetchWithRetry(`${SRV_URL}/api/resetTutorialProgress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: TEST_SLUG }),
      });
      expect([401, 403]).toContain(res.status);
    });

    it.skipIf(!TOKEN)(
      'POST /api/resetTutorialProgress with auth returns 200 (or 404 if test slug not seeded)',
      async () => {
        const res = await fetchWithRetry(`${SRV_URL}/api/resetTutorialProgress`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ slug: TEST_SLUG }),
        });

        // 200 — endpoint succeeded against a seeded slug; verify response shape.
        // 404 — endpoint reachable, slug not seeded; still proves auth + wiring.
        // 429 — rate limit (5/hr/user); also proves endpoint is wired and
        //       gated. Treated as a pass so repeated CI runs don't flake.
        expect([200, 404, 429]).toContain(res.status);

        if (res.status === 200) {
          const body = await res.json();
          expect(body).toHaveProperty('newAttemptNumber');
          expect(typeof body.newAttemptNumber).toBe('number');
          expect(body).toHaveProperty('supersededRecordCount');
          expect(typeof body.supersededRecordCount).toBe('number');
          // previousAttemptCompletedAt is nullable (null on a never-completed
          // tutorial, ISO DateTime string when there was a prior completion).
          expect(body).toHaveProperty('previousAttemptCompletedAt');
          if (body.previousAttemptCompletedAt !== null) {
            expect(typeof body.previousAttemptCompletedAt).toBe('string');
          }
        } else if (res.status === 404) {
          console.warn(
            `[smoke] /api/resetTutorialProgress reachable but test slug "${TEST_SLUG}" not seeded — set SMOKE_RESET_SLUG to a real tutorial slug the auth user has interacted with for a full 200 assertion.`,
          );
        } else if (res.status === 429) {
          console.warn(
            `[smoke] /api/resetTutorialProgress hit the per-user rate limit (5/hr). Endpoint is wired; retry after the window resets.`,
          );
        }
      },
    );
  },
);
