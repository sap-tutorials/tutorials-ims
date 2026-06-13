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

    <ui5-label for="deployment">Where do you typically deploy?</ui5-label>
    <ui5-select
      id="deployment"
      ref="deploymentRef"
      @change="(e) => onChange('deployment', e)"
    >
      <ui5-option value="__none__" :selected="prefs.deployment === null">— No preference —</ui5-option>
      <ui5-option value="cloud" :selected="prefs.deployment === 'cloud'">Cloud</ui5-option>
      <ui5-option value="onprem" :selected="prefs.deployment === 'onprem'">On-premise</ui5-option>
    </ui5-select>

    <ui5-label for="role">What's your role?</ui5-label>
    <ui5-select id="role" ref="roleRef" @change="(e) => onChange('role', e)">
      <ui5-option value="__none__" :selected="prefs.role === null">— No preference —</ui5-option>
      <ui5-option value="developer" :selected="prefs.role === 'developer'">Developer</ui5-option>
      <ui5-option value="architect" :selected="prefs.role === 'architect'">Architect</ui5-option>
      <ui5-option value="sysadmin" :selected="prefs.role === 'sysadmin'">System administrator</ui5-option>
      <ui5-option value="student" :selected="prefs.role === 'student'">Student</ui5-option>
    </ui5-select>

    <ui5-label for="cloud">Preferred cloud provider?</ui5-label>
    <ui5-select id="cloud" ref="cloudRef" @change="(e) => onChange('cloud', e)">
      <ui5-option value="__none__" :selected="prefs.cloud === null">— No preference —</ui5-option>
      <ui5-option value="btp" :selected="prefs.cloud === 'btp'">SAP BTP</ui5-option>
      <ui5-option value="aws" :selected="prefs.cloud === 'aws'">AWS</ui5-option>
      <ui5-option value="gcp" :selected="prefs.cloud === 'gcp'">Google Cloud</ui5-option>
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
import { ref, reactive, computed, onMounted } from 'vue';

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
});

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

defineExpose({ prefs, dirty, status, branchingDisabled, onChange, onSave });
</script>
