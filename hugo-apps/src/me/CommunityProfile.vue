<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';

interface Profile {
  linked: boolean;
  khorosId?: string;
  khorosLogin?: string;
  name?: string;
  rank?: string;
  avatarUrl?: string;
  profileUrl?: string;
}

const profile = reactive<Profile>({ linked: false });
const input = ref('');
const busy = ref(false);
const status = ref<'idle' | 'just-linked' | 'error'>('idle');
const errorStatus = ref<string | null>(null);

const errorDesign = computed(() =>
  errorStatus.value === 'upstream-unavailable' ? 'Information'
  : errorStatus.value === 'invalid-input'      ? 'Information'
  : 'Negative'
);

const errorMessage = computed(() => {
  switch (errorStatus.value) {
    case 'not-found':            return "We couldn't find that community user. The lookup needs at least one public post; lurkers can't be found.";
    case 'already-claimed':      return 'That community profile is already linked to another tutorial user.';
    case 'invalid-input':        return 'Enter your community login (e.g. thomas_jung) or numeric ID.';
    case 'upstream-unavailable': return 'SAP Community is unreachable right now. Try again in a few minutes.';
    case 'persist-failed':       return "Couldn't save. Try again.";
    default:                     return '';
  }
});

async function refresh({ allowUnlink = true } = {}) {
  try {
    const r = await fetch('/api/getKhorosProfile()', { credentials: 'include' });
    if (!r.ok) return;
    const body = await r.json() as Profile;
    // If server says unlinked but we have a local link claim that hasn't propagated yet,
    // don't clobber — let the next call resolve. Only skip when caller says to guard.
    if (!allowUnlink && !body.linked && profile.linked) return;
    Object.assign(profile, body);
    if (!body.linked) {
      profile.linked = false;
    }
  } catch { /* leave profile as-is */ }
}

async function onLink() {
  if (busy.value) return;
  const v = input.value.trim();
  if (!v) { errorStatus.value = 'invalid-input'; return; }
  busy.value = true; errorStatus.value = null;
  try {
    const r = await fetch('/api/setKhorosLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input: v }),
    });
    const body = await r.json();
    if (body.status === 'ok') {
      // Immediately populate the chip so the user sees feedback even if
      // refresh() races or returns stale data (e.g. test mock returning unlinked).
      profile.linked = true;
      profile.khorosId = body.khorosId;
      profile.khorosLogin = body.khorosLogin;
      profile.name = body.name;
      profile.profileUrl = `https://community.sap.com/t5/user/viewprofilepage/user-id/${body.khorosId}`;
      status.value = 'just-linked';
      input.value = '';
      // Best-effort refresh for rank + avatarUrl. Don't overwrite linked state
      // if the refresh returns linked:false (transient cache / mock case).
      refresh({ allowUnlink: false }).catch(() => {});
      setTimeout(() => { if (status.value === 'just-linked') status.value = 'idle'; }, 3000);
    } else {
      errorStatus.value = body.status;
    }
  } catch {
    errorStatus.value = 'upstream-unavailable';
  } finally {
    busy.value = false;
  }
}

async function onUnlink() {
  if (busy.value) return;
  busy.value = true;
  try {
    await fetch('/api/clearKhorosLink', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    await refresh();
  } finally { busy.value = false; }
}

function onAvatarError(e: Event) {
  (e.target as HTMLImageElement).style.visibility = 'hidden';
}

onMounted(refresh);

defineExpose({ profile, input, busy, status, errorStatus, errorMessage, errorDesign, onLink, onUnlink, refresh });
</script>

<template>
  <section class="community-profile">
    <ui5-title level="H4">SAP Community profile <span class="badge-new">NEW</span></ui5-title>
    <ui5-text>Link your community.sap.com profile to show it on your /me page and beyond.</ui5-text>

    <!-- UNLINKED -->
    <div v-if="!profile.linked" class="claim-row">
      <ui5-input
        :value="input"
        placeholder="thomas_jung or 123456"
        :disabled="busy"
        @input="(e: any) => (input = e.target.value)"
        @keydown.enter="onLink"
      />
      <ui5-button design="Emphasized" @click="onLink" :disabled="busy || !input.trim()">
        {{ busy ? 'Verifying…' : 'Link profile' }}
      </ui5-button>
      <details class="help">
        <summary>How do I find my community ID?</summary>
        <p>Open your profile at <a href="https://community.sap.com" target="_blank">community.sap.com</a>.
          The URL ends with either <code>/user-id/123456</code> (numeric ID) or
          <code>/user/thomas_jung</code> (login slug). Either works — paste it here.</p>
        <a href="https://developers.sap.com/tutorials/community-profile.html" target="_blank">
          More about your community profile ↗
        </a>
      </details>
      <ui5-message-strip
        v-if="errorStatus"
        :design="errorDesign"
        hide-close-button
      >{{ errorMessage }}</ui5-message-strip>
    </div>

    <!-- LINKED -->
    <div v-else class="linked-chip">
      <ui5-avatar size="S" shape="Circle">
        <img v-if="profile.avatarUrl" :src="profile.avatarUrl" :alt="profile.name" @error="onAvatarError" />
      </ui5-avatar>
      <div class="chip-text">
        <strong>{{ profile.name }}</strong>
        <span>@{{ profile.khorosLogin }}<template v-if="profile.rank"> · {{ profile.rank }}</template></span>
      </div>
      <a :href="profile.profileUrl" target="_blank">View profile ↗</a>
      <ui5-button design="Transparent" @click="onUnlink" :disabled="busy">Unlink</ui5-button>
    </div>

    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'just-linked'" design="Positive">
        Linked to {{ profile.name }}.
      </ui5-message-strip>
    </div>
  </section>
</template>

<style scoped>
.community-profile { padding-top: 0.5rem; }
.badge-new {
  font-size: 0.7rem; background: #fff4cf; padding: 0.05rem 0.35rem;
  border-radius: 3px; color: #7a5d00; font-weight: 400; vertical-align: 1px;
}
.claim-row {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  margin-top: 0.5rem;
}
.claim-row ui5-input { flex: 1; min-width: 12rem; }
.help { flex-basis: 100%; font-size: 0.85rem; color: var(--sapNeutralTextColor, #556); }
.help summary { cursor: pointer; }
.linked-chip {
  display: flex; align-items: center; gap: 0.7rem;
  padding: 0.6rem 0.7rem; margin-top: 0.5rem;
  border: 1px solid var(--sapList_BorderColor, #c6daee);
  border-radius: 6px; background: var(--sapList_Background, #fbfcfe);
}
.chip-text { flex: 1; min-width: 0; }
.chip-text strong { font-size: 0.9rem; }
.chip-text span {
  display: block; font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #666);
}
</style>
