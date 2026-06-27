<template>
  <div class="learning-preferences sapUiSmallMargin">
    <ui5-title level="H3">Learning preferences</ui5-title>
    <ui5-text>Help us personalize tutorial branching. All fields optional.</ui5-text>

    <ui5-message-strip
      v-if="branchingDisabled"
      design="Information"
      hide-close-button
    >
      Branching is currently disabled platform-wide. Your preferences will be saved
      and will activate when branching is turned on.
    </ui5-message-strip>

    <!--
      Issue #669: bind selection imperatively via the parent <ui5-select>'s
      `value` property (set in a watcher; see syncSelectValue below). Avoid
      Vue's `:selected` template binding on each <ui5-option>: that writes the
      HTML attribute, and per the UI5 spec, when multiple options resolve to
      `selected=""` the LAST one in document order wins — so reactive updates
      after mount silently fall back to the last vocab value (in our case
      On-premise / Student / Google Cloud). The UI5 docs are explicit:
      "Use either the Select's value or the Options' selected property.
      Mixed usage could result in unexpected behavior."
      Pattern source: [feedback_ui5_dialog_open_imperative_only].
    -->
    <ui5-label for="deployment">Where do you typically deploy?</ui5-label>
    <ui5-select
      id="deployment"
      ref="deploymentRef"
      @change="(e) => onChange('deployment', e)"
    >
      <ui5-option value="__none__">— No preference —</ui5-option>
      <ui5-option
        v-for="value in PROFILE_VOCAB.deployment"
        :key="value"
        :value="value"
      >{{ DEPLOYMENT_LABEL[value] || value }}</ui5-option>
    </ui5-select>

    <ui5-label for="role">What's your role?</ui5-label>
    <ui5-select id="role" ref="roleRef" @change="(e) => onChange('role', e)">
      <ui5-option value="__none__">— No preference —</ui5-option>
      <ui5-option
        v-for="value in PROFILE_VOCAB.role"
        :key="value"
        :value="value"
      >{{ ROLE_LABEL[value] || value }}</ui5-option>
    </ui5-select>

    <ui5-label for="cloud">Preferred cloud provider?</ui5-label>
    <ui5-select id="cloud" ref="cloudRef" @change="(e) => onChange('cloud', e)">
      <ui5-option value="__none__">— No preference —</ui5-option>
      <ui5-option
        v-for="value in PROFILE_VOCAB.cloud"
        :key="value"
        :value="value"
      >{{ CLOUD_LABEL[value] || value }}</ui5-option>
    </ui5-select>

    <ui5-button design="Emphasized" :disabled="!dirty || saving" @click="onSave">
      {{ saving ? 'Saving…' : 'Save preferences' }}
    </ui5-button>

    <!-- A11y (I15): wrap status strip in role=alert live region -->
    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'saved'" design="Positive">Saved.</ui5-message-strip>
      <ui5-message-strip v-if="status === 'error'" design="Negative">
        Couldn't save preferences. Try again.
      </ui5-message-strip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue';
// PR 6: import vocabulary from the single source of truth (single source of
// truth is srv/lib/branch/profile-fields.js — also imported by the action
// handler and used by the schema-drift guard test). Vite resolves the relative
// path; Vue island and CAP service stay byte-equivalent in vocabulary.
import { PROFILE_VOCAB } from '../../../srv/lib/branch/profile-fields.js';

// Human-readable labels keyed by canonical enum value. Adding a new value to
// PROFILE_VOCAB without a matching label entry falls back to the raw value
// (see template's `|| value` fallback) — safe degradation.
const DEPLOYMENT_LABEL: Record<string, string> = { cloud: 'Cloud', onprem: 'On-premise' };
const ROLE_LABEL: Record<string, string> = {
  developer: 'Developer',
  architect: 'Architect',
  sysadmin: 'System administrator',
  student: 'Student',
};
// Issue #669: include the major cloud providers explicitly (was 3 of ~7).
// Adding a key here without growing PROFILE_VOCAB.cloud is a no-op — labels
// fall back to the raw value via `|| value` in the template anyway.
const CLOUD_LABEL: Record<string, string> = {
  btp:      'SAP BTP',
  aws:      'AWS',
  gcp:      'Google Cloud',
  azure:    'Microsoft Azure',
  alibaba:  'Alibaba Cloud',
  oracle:   'Oracle Cloud',
  ibm:      'IBM Cloud',
};

type ProfileField = 'deployment' | 'role' | 'cloud';
type ProfileValue = string | null;

const prefs = reactive<{ deployment: ProfileValue; role: ProfileValue; cloud: ProfileValue }>({
  deployment: null, role: null, cloud: null,
});
const dirty = ref(false);
const status = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const branchingDisabled = ref(false);
const saving = computed(() => status.value === 'saving');

const deploymentRef = ref<HTMLElement | null>(null);
const roleRef = ref<HTMLElement | null>(null);
const cloudRef = ref<HTMLElement | null>(null);

let savedTimer: number | undefined;

// Issue #669: imperatively drive selection via <ui5-select>.value (the
// docs-recommended API path). The previous approach — `:selected` on each
// <ui5-option> — silently fell back to the LAST option after mount because
// every `false`-bound attribute still emitted `selected=""` and UI5 picks the
// last sibling when multiple options claim selection. Set both the select's
// `value` and the option's reflected `selected` so a single re-read of the
// DOM (e.g. by tests, screen readers) sees consistent state.
function syncSelectValue(selectEl: HTMLElement | null, value: ProfileValue) {
  if (!selectEl) return;
  // null → the "__none__" sentinel option so the placeholder shows.
  (selectEl as any).value = value ?? '__none__';
}

onMounted(async () => {
  // Fetch existing prefs (collection — extract first row)
  try {
    const resp = await fetch('/api/LearningPreferences', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      const row = data.value?.[0];
      if (row) {
        prefs.deployment = row.deployment ?? null;
        prefs.role = row.role ?? null;
        prefs.cloud = row.cloud ?? null;
      }
    }
  } catch {
    // silent — empty form is the safe default
  }

  // Fetch master flag (singleton)
  try {
    const resp = await fetch('/api/ChatConfig', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      branchingDisabled.value = data?.branchingEnabled === false;
    }
  } catch {
    // silent — show form without the disabled-info strip
  }

  // Push initial values into the UI5 selects. nextTick guarantees Vue has
  // rendered the refs. We do NOT await customElements.whenDefined('ui5-select')
  // because (a) in happy-dom that promise never resolves (no UI5 in tests)
  // and (b) UI5's connectedCallback reads the `value` property at upgrade
  // time regardless, so an early write is safe.
  await nextTick();
  syncSelectValue(deploymentRef.value, prefs.deployment);
  syncSelectValue(roleRef.value, prefs.role);
  syncSelectValue(cloudRef.value, prefs.cloud);
});

// Keep the DOM selects in step with prefs after the initial mount. Covers the
// post-save case (state stays in sync if any other code mutates prefs) plus a
// belt-and-braces guard against UI5 re-rendering its slotted options.
watch(() => prefs.deployment, (v) => syncSelectValue(deploymentRef.value, v));
watch(() => prefs.role,       (v) => syncSelectValue(roleRef.value, v));
watch(() => prefs.cloud,      (v) => syncSelectValue(cloudRef.value, v));

function onChange(field: ProfileField, ev: any) {
  const raw = ev?.detail?.selectedOption?.value ?? '__none__';
  prefs[field] = raw === '__none__' ? null : raw;
  dirty.value = true;
}

async function onSave() {
  if (!dirty.value || status.value === 'saving') return;
  status.value = 'saving';
  if (savedTimer) clearTimeout(savedTimer);
  try {
    const resp = await fetch('/api/setLearningPreferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        deployment: prefs.deployment,
        role: prefs.role,
        cloud: prefs.cloud,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    status.value = 'saved';
    dirty.value = false;
    savedTimer = window.setTimeout(() => { if (status.value === 'saved') status.value = 'idle'; }, 3000);
  } catch {
    status.value = 'error';
    // A11y: focus the first Select for the user to retry
    const focusable = (deploymentRef.value as any) || (roleRef.value as any) || (cloudRef.value as any);
    focusable?.focus?.();
  }
}

// test-only: expose mutable internals for the Vue test harness (vue-test-utils
// setup-script bindings need this). All shape-relevant state for assertions.
defineExpose({ prefs, dirty, status, branchingDisabled, onChange, onSave, PROFILE_VOCAB });
</script>
