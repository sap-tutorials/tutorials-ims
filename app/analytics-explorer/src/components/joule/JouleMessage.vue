<script setup lang="ts">
import '@ui5/webcomponents/dist/Button.js'
import type { JouleMessage } from '../../composables/useJouleChat'

const props = defineProps<{ message: JouleMessage }>()
const emit = defineEmits<{ (e: 'view-in-builder', spec: any): void }>()

function onViewInBuilder() {
  if (props.message.kind === 'generated-query') emit('view-in-builder', (props.message as any).spec)
}
</script>

<template>
  <div
    class="joule-msg"
    :class="{
      'joule-msg-user': message.role === 'user',
      'joule-msg-assistant': message.role === 'assistant',
      'joule-msg-error': (message as any).kind === 'error',
    }"
  >
    <template v-if="message.role === 'user'">
      <div class="bubble">{{ (message as any).text }}</div>
    </template>

    <template v-else-if="(message as any).kind === 'text'">
      <div class="bubble">{{ (message as any).text }}</div>
    </template>

    <template v-else-if="(message as any).kind === 'generated-query'">
      <div class="bubble">
        <p v-if="(message as any).explanation" class="explanation">{{ (message as any).explanation }}</p>
        <pre class="sql"><code>{{ (message as any).sql }}</code></pre>
        <div class="actions">
          <ui5-button design="Emphasized" data-test="view-in-builder" @click="onViewInBuilder">View in builder</ui5-button>
          <span class="badge" title="PII columns redacted before sending to the AI">🔒 PII redacted</span>
        </div>
        <ul v-if="(message as any).errors?.length" class="errors">
          <li v-for="(e, i) in (message as any).errors" :key="i">{{ e.message }}</li>
        </ul>
      </div>
    </template>

    <template v-else-if="(message as any).kind === 'explanation'">
      <div class="bubble">{{ (message as any).summary }}</div>
    </template>

    <template v-else-if="(message as any).kind === 'error'">
      <div class="bubble error">{{ (message as any).text }}</div>
    </template>
  </div>
</template>

<style scoped>
.joule-msg { display: flex; margin-bottom: 0.5rem; }
.joule-msg-user { justify-content: flex-end; }
.joule-msg-assistant { justify-content: flex-start; }
.bubble {
  max-width: 90%;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: var(--sapList_Background);
  border: 1px solid var(--sapField_BorderColor);
  font-size: 0.85rem;
  white-space: pre-wrap;
}
.joule-msg-user .bubble { background: var(--sapButton_Emphasized_Background); color: var(--sapButton_Emphasized_TextColor); }
.bubble.error { background: var(--sapErrorBackground); border-color: var(--sapErrorBorderColor); color: var(--sapErrorTextColor); }
.explanation { margin: 0 0 0.4rem; font-style: italic; color: var(--sapNeutralTextColor); }
.sql { background: var(--sapShell_Background); padding: 0.5rem; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; margin: 0; }
.actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
.badge { font-size: 0.7rem; color: var(--sapNeutralTextColor); }
.errors { color: var(--sapErrorColor); margin: 0.4rem 0 0; padding-left: 1rem; font-size: 0.78rem; }
</style>
