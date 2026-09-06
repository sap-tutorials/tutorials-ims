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
  <section v-if="ready" class="channel-submit">
    <div class="channel-submit__card">
      <h2 class="channel-submit__title">Suggest a channel</h2>

      <template v-if="!authed">
        <p class="channel-submit__intro">
          Know a channel we're missing? <a href="/login">Log in</a> to suggest one.
        </p>
      </template>

      <template v-else-if="status === 'done'">
        <p class="channel-submit__ok">Thanks — your suggestion is queued for review.</p>
      </template>

      <template v-else>
        <p class="channel-submit__intro">
          Spotted a channel that belongs here — or one that needs fixing? Tell us below and a
          curator will review it.
        </p>
        <form @submit.prevent="onSubmit" class="channel-submit__form">
          <div class="field">
            <label class="field__label" for="cs-kind">What would you like to do?</label>
            <select id="cs-kind" v-model="kind" class="field__control">
              <option value="ADD">Add a new channel</option>
              <option value="EDIT">Propose an edit to an existing channel</option>
              <option value="REMOVE">Flag a channel for removal</option>
            </select>
          </div>

          <div class="field" v-if="kind !== 'ADD'">
            <label class="field__label" for="cs-target">Channel ID</label>
            <input id="cs-target" v-model="targetChannelId" class="field__control" required />
            <span class="field__hint">The <code>sourceId</code> of the channel (shown on its directory card).</span>
          </div>

          <template v-if="kind !== 'REMOVE'">
            <div class="field">
              <label class="field__label" for="cs-name">Name</label>
              <input id="cs-name" v-model="name" class="field__control" :required="kind === 'ADD'" />
            </div>
            <div class="field">
              <label class="field__label" for="cs-url">URL</label>
              <input id="cs-url" v-model="url" class="field__control" :required="kind === 'ADD'" type="url" placeholder="https://…" />
            </div>
            <div class="field">
              <label class="field__label" for="cs-purpose">Purpose</label>
              <textarea id="cs-purpose" v-model="purpose" class="field__control" rows="3" placeholder="What is this channel for?"></textarea>
            </div>
            <div class="field">
              <label class="field__label" for="cs-owner">Owner</label>
              <input id="cs-owner" v-model="ownerName" class="field__control" placeholder="Who runs it?" />
            </div>
          </template>

          <div class="field">
            <label class="field__label" for="cs-why">Why?</label>
            <textarea id="cs-why" v-model="rationale" class="field__control" rows="3" placeholder="Give the curator some context."></textarea>
          </div>

          <div class="channel-submit__actions">
            <button type="submit" class="channel-submit__btn" :disabled="status === 'sending'">
              {{ status === 'sending' ? 'Submitting…' : 'Submit suggestion' }}
            </button>
          </div>
          <p v-if="status === 'error'" class="channel-submit__err" role="alert">
            Something went wrong — please try again.
          </p>
        </form>
      </template>
    </div>
  </section>
</template>

<style scoped>
.channel-submit {
  margin-top: 2.5rem;
}
.channel-submit__card {
  max-width: 42rem;
  padding: 1.5rem 1.75rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
  box-shadow: var(--sapContent_Shadow0, 0 0 0.25rem rgba(0, 0, 0, 0.1));
}
.channel-submit__title {
  margin: 0 0 0.25rem;
  font-size: 1.25rem;
  color: var(--sapGroup_TitleTextColor, #1d2d3e);
}
.channel-submit__intro {
  margin: 0 0 1.25rem;
  color: var(--sapNeutralTextColor, #556b82);
}
.channel-submit__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.field__label {
  font-weight: 600;
  color: var(--sapField_TextColor, #1d2d3e);
}
.field__control {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.625rem;
  font: inherit;
  color: var(--sapField_TextColor, #1d2d3e);
  background: var(--sapField_Background, #fff);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
}
.field__control:focus {
  outline: none;
  border-color: var(--sapField_Focus_BorderColor, #0070f2);
  box-shadow: 0 0 0 1px var(--sapField_Focus_BorderColor, #0070f2);
}
textarea.field__control {
  resize: vertical;
  min-height: 3.5rem;
}
.field__hint {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
}
.field__hint code {
  font-size: 0.8125rem;
}
.channel-submit__actions {
  margin-top: 0.25rem;
}
.channel-submit__btn {
  padding: 0.5rem 1.25rem;
  font: inherit;
  font-weight: 600;
  color: var(--sapButton_Emphasized_TextColor, #fff);
  background: var(--sapButton_Emphasized_Background, #0070f2);
  border: 1px solid var(--sapButton_Emphasized_BorderColor, #0070f2);
  border-radius: var(--sapButton_BorderCornerRadius, 0.375rem);
  cursor: pointer;
}
.channel-submit__btn:hover:not(:disabled) {
  background: var(--sapButton_Emphasized_Hover_Background, #0064d9);
}
.channel-submit__btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.channel-submit__ok {
  color: var(--sapPositiveTextColor, #256f3a);
  font-weight: 600;
}
.channel-submit__err {
  margin: 0.5rem 0 0;
  color: var(--sapNegativeTextColor, #aa0808);
}
</style>
