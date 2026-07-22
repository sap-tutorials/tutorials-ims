# Task 7 Fix Report — Final review rollout-safety findings

**Status:** COMPLETE

---

## Finding 1 (Important) — Admin secret rotation did not flush App installation-token cache

**Files changed:**
- `srv/admin-service.js`

**Import added** (line 19):
```javascript
import { invalidateInstallationToken } from './lib/github-app-token.js';
```

**Logic added** after each `invalidateSecret(row.key)` in all three handlers
(`setSecretValue` ~line 2315, `rotateSecretValue` ~line 2373, `clearSecretValue` ~line 2417):
```javascript
if (row.key === 'TUTORIALS_APP_ID' || row.key === 'TUTORIALS_APP_INSTALLATION_ID' || row.key === 'TUTORIALS_APP_PRIVATE_KEY') {
  invalidateInstallationToken();
}
```

This ensures rotating any GitHub App credential via `/admin-ui/#secrets` immediately
clears the ~55-min cached installation token so the next caller mints fresh.

---

## Finding 2 (Minor) — Workflow template `||` fallback comment was misleading

**File changed:**
- `.github/workflows/notify-qa.yml.template`

**Comment appended** inside the existing block above the `Generate GitHub App token` step:
```
# NOTE: the || fallback below only engages if App-token GENERATION fails —
# NOT if dispatch is unauthorized. Grant the App Contents:write on
# tutorials-ims BEFORE setting USE_GITHUB_APP=true here (see runbook).
```

**YAML validation:**
```
$ yq '.' .github/workflows/notify-qa.yml.template > /dev/null && echo "valid YAML"
valid YAML
```

---

## Test result

```
npx vitest run test/unit/admin-secret-value-handlers.test.js

Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  9.09s
```

Two new tests added in `test/unit/admin-secret-value-handlers.test.js`:
- `setSecretValue on TUTORIALS_APP_PRIVATE_KEY flushes installation-token cache` — primes the `globalThis[Symbol.for('...github-app-token')]` singleton to a known value, calls the handler, asserts the token is null afterward.
- `setSecretValue on a non-App key (SMTP_PASS) does NOT flush installation-token cache` — asserts the primed token is unchanged after handling a non-App key, preventing false-positive flushes.

All 14 tests pass (12 pre-existing + 2 new).

---

## Commit SHA

(see commit below)
