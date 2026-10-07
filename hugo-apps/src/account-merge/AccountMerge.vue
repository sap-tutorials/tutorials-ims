<template>
  <div class="account-merge sapUiSmallMargin">
    <ui5-title level="H2">Merge account history</ui5-title>
    <ui5-text>
      Transfer all tutorial progress, completions, and points from another account
      into this one. The source account's history is moved here permanently.
    </ui5-text>

    <!-- Unauthenticated: no personal data, no action form. -->
    <div v-if="needsLogin" class="account-merge__signin" role="status">
      <ui5-message-strip design="Information" hide-close-button>
        Please <a :href="loginHref">sign in</a> to merge account history.
      </ui5-message-strip>
    </div>

    <template v-else>
      <!-- ── CONFIRM STATE: ?token= present in URL ── -->
      <template v-if="confirmToken">
        <div role="alert" aria-live="polite">
          <ui5-message-strip v-if="confirmResult === 'MERGED'" design="Positive">
            <strong>Merge complete.</strong>
            <template v-if="movedSummary"> {{ movedSummary }}</template>
            <br />
            <a href="/me">Back to your profile</a>
          </ui5-message-strip>

          <ui5-message-strip v-else-if="confirmResult === 'WRONG_ACCOUNT'" design="Negative">
            Open this link while signed in as the account you want to keep.
          </ui5-message-strip>

          <ui5-message-strip v-else-if="confirmResult === 'EXPIRED' || confirmResult === 'INVALID'" design="Negative">
            This link is no longer valid — <a href="/me/merge">start again from /me/merge</a>.
          </ui5-message-strip>

          <ui5-message-strip v-else-if="confirmError" design="Negative">{{ confirmError }}</ui5-message-strip>
        </div>

        <!-- Show the confirmation prompt only before submission -->
        <template v-if="!confirmResult && !confirmError">
          <div class="account-merge__warning" role="alert">
            <ui5-message-strip design="Warning" hide-close-button>
              You're about to permanently merge the history from the other account
              into <strong>this</strong> one. This cannot be undone.
            </ui5-message-strip>
          </div>
          <div class="account-merge__actions">
            <ui5-button design="Emphasized" data-test="confirm-merge-btn"
                        :disabled="confirming" @click="onConfirm">
              {{ confirming ? 'Merging…' : 'Confirm merge' }}
            </ui5-button>
          </div>
        </template>
      </template>

      <!-- ── REQUEST STATE: no ?token= ── -->
      <template v-else>
        <div role="alert" aria-live="polite">
          <ui5-message-strip v-if="requestResult === 'SENT'" design="Positive">
            If that account exists, we've sent a verification link to it.
            Open the link while signed in here.
          </ui5-message-strip>

          <ui5-message-strip v-else-if="requestResult === 'BLOCKED_SELF'" design="Negative">
            That's the account you're already signed in as.
          </ui5-message-strip>

          <ui5-message-strip v-else-if="requestResult === 'RATE_LIMITED'" design="Warning">
            Too many requests — try again later.
          </ui5-message-strip>

          <ui5-message-strip v-else-if="requestError" design="Negative">{{ requestError }}</ui5-message-strip>
        </div>

        <template v-if="!requestResult">
          <div class="account-merge__field">
            <label for="merge-target-email">Target account email</label>
            <input id="merge-target-email" v-model="targetEmail" type="email"
                   maxlength="254" placeholder="other-account@example.com" />
          </div>
          <div class="account-merge__actions">
            <ui5-button design="Emphasized" data-test="send-verification-btn"
                        :disabled="!canRequest || requesting" @click="onRequest">
              {{ requesting ? 'Sending…' : 'Send verification email' }}
            </ui5-button>
          </div>
        </template>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { csrfFetch } from '@shared/csrf-fetch';

// ── Login gate ────────────────────────────────────────────────────────────────

const needsLogin = ref(false);

// The approuter returns 200 + an XSUAA login-redirect HTML page (NOT 401) for a
// lapsed/anonymous session. A truthy signal requires JSON + body.authenticated —
// never resp.ok alone. Mirrors ApiTokens.vue / homepage-personalizer/coordinator.ts.
async function isSignedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    if (!r.ok) return false;
    if (!(r.headers.get('content-type') || '').includes('json')) return false;
    const body = await r.json();
    return !!body?.authenticated;
  } catch { return false; }
}

const loginHref = '/login?siteUrl=' + encodeURIComponent(
  typeof location !== 'undefined' ? location.pathname : '/me/merge/'
);

// ── URL state: confirm vs. request ───────────────────────────────────────────

// Read ?token= from the URL once on mount (SSR-safe: guarded by onMounted).
const confirmToken = ref<string | null>(null);

// ── Request state ─────────────────────────────────────────────────────────────

const targetEmail = ref('');
const requesting = ref(false);
const requestResult = ref<'SENT' | 'BLOCKED_SELF' | 'RATE_LIMITED' | null>(null);
const requestError = ref('');

const canRequest = computed(() => targetEmail.value.trim().length > 0);

async function onRequest() {
  if (!canRequest.value || requesting.value) return;
  requesting.value = true;
  requestError.value = '';
  try {
    const resp = await csrfFetch('/api/requestAccountMerge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ targetEmail: targetEmail.value.trim() }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const r = data?.value ?? data;
    requestResult.value = r.status;
  } catch {
    requestError.value = "Couldn't send the verification email. Try again.";
  } finally {
    requesting.value = false;
  }
}

// ── Confirm state ─────────────────────────────────────────────────────────────

const confirming = ref(false);
const confirmResult = ref<'MERGED' | 'WRONG_ACCOUNT' | 'EXPIRED' | 'INVALID' | null>(null);
const confirmError = ref('');
const movedSummary = ref('');

async function onConfirm() {
  if (confirming.value || !confirmToken.value) return;
  confirming.value = true;
  confirmError.value = '';
  try {
    const resp = await csrfFetch('/api/confirmAccountMerge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: confirmToken.value }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const r = data?.value ?? data;
    confirmResult.value = r.status;
    if (r.status === 'MERGED' && r.movedCounts) {
      try {
        const counts = typeof r.movedCounts === 'string' ? JSON.parse(r.movedCounts) : r.movedCounts;
        // Map engine keys to human-readable labels.
        const LABELS: Record<string, string> = {
          puzzleProgress:       'puzzle progress',
          petSubmissions:       'pet submissions',
          envTabs:              'environment tabs',
          sessionFavorites:     'session favorites',
          userMetaData:         'profile settings',
          learningPrefs:        'learning preferences',
          taskRecordsDeduped:   'duplicate completions removed',
        };
        const parts: string[] = [];
        for (const [key, label] of Object.entries(LABELS)) {
          const val = (counts as Record<string, number>)[key];
          if (val && val > 0) parts.push(`${val} ${label}`);
        }
        if (parts.length) movedSummary.value = `Moved: ${parts.join(', ')}.`;
      } catch {
        // movedCounts parse failed — skip summary, not load-bearing
      }
    }
  } catch {
    confirmError.value = "Couldn't complete the merge. Try again or start over from /me/merge.";
  } finally {
    confirming.value = false;
  }
}

// ── Mount ─────────────────────────────────────────────────────────────────────

onMounted(async () => {
  // Read ?token= before the auth check so confirmToken is set for the template.
  confirmToken.value = new URLSearchParams(location.search).get('token');

  if (!(await isSignedIn())) {
    needsLogin.value = true;
    return;
  }
});

// Exposed for the Vue test harness.
defineExpose({
  needsLogin, confirmToken,
  targetEmail, requesting, requestResult, requestError, canRequest, onRequest,
  confirming, confirmResult, confirmError, movedSummary, onConfirm,
});
</script>

<style scoped>
.account-merge { max-width: 40rem; }
.account-merge__field { display: flex; flex-direction: column; gap: 0.25rem; margin: 1rem 0; max-width: 28rem; }
.account-merge__field input { padding: 0.4rem 0.5rem; font: inherit; }
.account-merge__warning { margin: 1rem 0; }
.account-merge__actions { margin: 0.75rem 0; }
</style>
