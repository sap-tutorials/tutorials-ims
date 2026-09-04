<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { probeAuth, submitChannelProposal, type ChannelProposal } from './lib/submit';

const authed = ref(false);
const ready = ref(false);
const kind = ref<ChannelProposal['kind']>('ADD');
const name = ref('');
const url = ref('');
const purpose = ref('');
const ownerName = ref('');
const targetChannelId = ref('');
const rationale = ref('');
const status = ref<'idle' | 'sending' | 'done' | 'error'>('idle');

onMounted(async () => { authed.value = await probeAuth(); ready.value = true; });

async function onSubmit() {
  status.value = 'sending';
  try {
    const proposed = kind.value === 'REMOVE'
      ? ''
      : JSON.stringify(Object.fromEntries(
          Object.entries({ name: name.value, url: url.value, purpose: purpose.value, ownerName: ownerName.value })
            .filter(([, v]) => v),
        ));
    await submitChannelProposal({
      kind: kind.value,
      ...(kind.value === 'ADD' ? {} : { targetChannel_ID: targetChannelId.value }),
      proposed,
      rationale: rationale.value,
    });
    status.value = 'done';
  } catch {
    status.value = 'error';
  }
}
</script>

<template>
  <div v-if="ready" class="channel-submit">
    <template v-if="!authed">
      <p>Know a channel we're missing? <a href="/login">Log in</a> to suggest one.</p>
    </template>
    <template v-else-if="status === 'done'">
      <p class="channel-submit__ok">Thanks — your suggestion is queued for review.</p>
    </template>
    <form v-else @submit.prevent="onSubmit" class="channel-submit__form">
      <h2>Suggest a channel</h2>
      <label>Type
        <select v-model="kind">
          <option value="ADD">Add a new channel</option>
          <option value="EDIT">Propose an edit</option>
          <option value="REMOVE">Flag for removal</option>
        </select>
      </label>
      <template v-if="kind !== 'ADD'">
        <label>Channel ID <input v-model="targetChannelId" required /></label>
      </template>
      <template v-if="kind !== 'REMOVE'">
        <label>Name <input v-model="name" :required="kind === 'ADD'" /></label>
        <label>URL <input v-model="url" :required="kind === 'ADD'" type="url" /></label>
        <label>Purpose <textarea v-model="purpose"></textarea></label>
        <label>Owner <input v-model="ownerName" /></label>
      </template>
      <label>Why? <textarea v-model="rationale"></textarea></label>
      <button type="submit" :disabled="status === 'sending'">Submit</button>
      <p v-if="status === 'error'" class="channel-submit__err">Something went wrong — please try again.</p>
    </form>
  </div>
</template>
