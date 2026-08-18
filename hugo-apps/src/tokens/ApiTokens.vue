<template>
  <div class="api-tokens sapUiSmallMargin">
    <ui5-title level="H2">API tokens</ui5-title>
    <ui5-text>
      Personal Access Tokens (PATs) let headless clients — the hosted MCP server,
      CI jobs, scripts — authenticate as you without a browser sign-in. Send one as
      <code>Authorization: Bearer pat_…</code>. Tokens inherit your account's access;
      treat them like passwords.
    </ui5-text>

    <!-- Unauthenticated: no personal data, no mint form. -->
    <div v-if="needsLogin" class="api-tokens__signin" role="status">
      <ui5-message-strip design="Information" hide-close-button>
        Please <a :href="loginHref">sign in</a> to view and mint your API tokens.
      </ui5-message-strip>
    </div>

    <template v-else>
      <!-- One-time plaintext reveal. Shown ONCE, right after minting. -->
      <div v-if="minted" class="api-tokens__reveal" role="alert" aria-live="assertive">
        <ui5-message-strip design="Warning" hide-close-button>
          Copy this token now — it won't be shown again.
        </ui5-message-strip>
        <div class="api-tokens__reveal-row">
          <code class="api-tokens__secret" data-test="minted-token">{{ minted.token }}</code>
          <ui5-button icon="copy" design="Emphasized" data-test="copy-btn" @click="copyToken">
            {{ copied ? 'Copied' : 'Copy' }}
          </ui5-button>
          <ui5-button design="Transparent" data-test="dismiss-btn" @click="dismissMinted">Done</ui5-button>
        </div>
      </div>

      <!-- Create form -->
      <div class="api-tokens__create">
        <ui5-title level="H3">Create a token</ui5-title>
        <div class="api-tokens__field">
          <label :for="'tok-name'">Name</label>
          <input id="tok-name" v-model="form.name" type="text" maxlength="80"
                 placeholder="e.g. claude-desktop" />
        </div>
        <div class="api-tokens__field">
          <label :for="'tok-scope'">Access</label>
          <select id="tok-scope" v-model="form.scope">
            <option value="read">Read only</option>
            <option value="readwrite">Read &amp; write (mark steps done, reset progress)</option>
          </select>
        </div>
        <div class="api-tokens__field">
          <label :for="'tok-ttl'">Expires</label>
          <select id="tok-ttl" v-model.number="form.ttlDays">
            <option :value="30">30 days</option>
            <option :value="90">90 days</option>
            <option :value="180">180 days</option>
            <option :value="365">1 year</option>
            <option :value="0">No expiry</option>
          </select>
        </div>
        <ui5-button design="Emphasized" data-test="mint-btn"
                    :disabled="!canMint || minting" @click="onMint">
          {{ minting ? 'Creating…' : 'Create token' }}
        </ui5-button>
      </div>

      <div role="alert" aria-live="polite">
        <ui5-message-strip v-if="error" design="Negative">{{ error }}</ui5-message-strip>
      </div>

      <!-- Existing tokens -->
      <ui5-title level="H3">Your tokens</ui5-title>
      <ui5-text v-if="!loading && tokens.length === 0">You have no tokens yet.</ui5-text>
      <table v-else class="api-tokens__table">
        <thead>
          <tr>
            <th>Name</th><th>Prefix</th><th>Access</th><th>Created</th>
            <th>Expires</th><th>Last used</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tokens" :key="t.ID" :class="{ 'is-revoked': !!t.revokedAt }">
            <td>{{ t.name }}</td>
            <td><code>{{ t.prefix }}</code></td>
            <td>{{ (t.scopes || []).join(' + ') || 'read' }}</td>
            <td>{{ fmtDate(t.createdAt) }}</td>
            <td>{{ t.expiresAt ? fmtDate(t.expiresAt) : 'Never' }}</td>
            <td>{{ t.lastUsedAt ? fmtDate(t.lastUsedAt) : '—' }}</td>
            <td>{{ t.statusText || (t.revokedAt ? 'Revoked' : 'Active') }}</td>
            <td>
              <ui5-button v-if="isRevocable(t)" design="Transparent"
                          :data-test="`revoke-${t.ID}`" @click="onRevoke(t.ID)">Revoke</ui5-button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { csrfFetch } from '@shared/csrf-fetch';

interface Pat {
  ID: string; name: string; prefix: string; scopes: string[];
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
  revokedAt: string | null; statusText?: string; revocable?: boolean;
}

const needsLogin = ref(false);
const loading = ref(true);
const tokens = ref<Pat[]>([]);
const error = ref('');
const minting = ref(false);
const minted = ref<{ token: string; prefix: string; expiresAt: string | null } | null>(null);
const copied = ref(false);

const form = reactive<{ name: string; scope: 'read' | 'readwrite'; ttlDays: number }>({
  name: '', scope: 'read', ttlDays: 90,
});

const canMint = computed(() => form.name.trim().length > 0);
// Post-login redirect back to this page.
const loginHref = '/login?siteUrl=' + encodeURIComponent(
  typeof location !== 'undefined' ? location.pathname : '/me/tokens/'
);

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

// A revoked token is not revocable. Server sends `revocable`; fall back to the
// revokedAt timestamp when the virtual field is absent (e.g. older payloads).
function isRevocable(t: Pat): boolean {
  return t.revocable ?? !t.revokedAt;
}

async function loadTokens() {
  loading.value = true;
  try {
    const resp = await fetch('/pats/MyPATs', {
      headers: { Accept: 'application/json' }, credentials: 'include',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    tokens.value = data.value ?? [];
  } catch {
    error.value = "Couldn't load your tokens. Try refreshing.";
  } finally {
    loading.value = false;
  }
}

async function onMint() {
  if (!canMint.value || minting.value) return;
  minting.value = true;
  error.value = '';
  try {
    const scopes = form.scope === 'readwrite' ? ['read', 'write'] : ['read'];
    // ttlDays 0 → no expiry (null); the CDS default is 90 days.
    const ttlDays = form.ttlDays > 0 ? form.ttlDays : null;
    const resp = await csrfFetch('/pats/mintPAT', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: form.name.trim(), scopes, ttlDays }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const r = data?.value ?? data;
    minted.value = { token: r.token, prefix: r.prefix, expiresAt: r.expiresAt ?? null };
    copied.value = false;
    form.name = '';
    await loadTokens();
  } catch {
    error.value = "Couldn't create the token. Try again.";
  } finally {
    minting.value = false;
  }
}

async function onRevoke(id: string) {
  error.value = '';
  try {
    // Bound action on the MyPATs row; key predicate carries the GUID.
    const resp = await csrfFetch(`/pats/MyPATs(${id})/PatService.revokePAT`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: '{}',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await loadTokens();
  } catch {
    error.value = "Couldn't revoke that token. Try again.";
  }
}

function dismissMinted() {
  minted.value = null;
  copied.value = false;
}

async function copyToken() {
  if (!minted.value) return;
  try {
    await navigator.clipboard.writeText(minted.value.token);
    copied.value = true;
  } catch {
    // Clipboard blocked — the token stays visible for manual copy.
  }
}

onMounted(async () => {
  // Gate on session like the other /me islands. 401/403 → sign-in prompt.
  try {
    const resp = await fetch('/auth/user', { credentials: 'include' });
    if (!resp.ok) { needsLogin.value = true; loading.value = false; return; }
  } catch {
    needsLogin.value = true; loading.value = false; return;
  }
  await loadTokens();
});

// Exposed for the Vue test harness (mirrors the /me islands' defineExpose).
defineExpose({ needsLogin, loading, tokens, form, minted, error, minting, onMint, onRevoke, dismissMinted, loadTokens });
</script>

<style scoped>
.api-tokens { max-width: 60rem; }
.api-tokens__field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.5rem 0; max-width: 28rem; }
.api-tokens__field input, .api-tokens__field select { padding: 0.4rem 0.5rem; font: inherit; }
.api-tokens__create { margin: 1rem 0; }
.api-tokens__reveal { margin: 1rem 0; }
.api-tokens__reveal-row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap; }
.api-tokens__secret { font-family: monospace; padding: 0.4rem 0.6rem; background: var(--sapNeutralBackground, #eee); border-radius: 4px; word-break: break-all; }
.api-tokens__table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
.api-tokens__table th, .api-tokens__table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--sapList_BorderColor, #ddd); font-size: 0.875rem; }
.api-tokens__table tr.is-revoked { opacity: 0.55; }
</style>
