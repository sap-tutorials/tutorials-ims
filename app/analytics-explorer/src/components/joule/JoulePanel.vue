<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import JouleMessage from './JouleMessage.vue'
import { useJouleChat } from '../../composables/useJouleChat'
import { useJouleContext } from '../../composables/useJouleContext'

const emit = defineEmits<{ (e: 'close'): void; (e: 'view-in-builder', spec: any): void }>()

const chat = useJouleChat()
const ctx = useJouleContext()
const draft = ref('')
const listRef = ref<HTMLDivElement | null>(null)

async function onSend() {
  const text = draft.value.trim()
  if (!text || chat.streaming.value) return
  draft.value = ''
  const pc = await ctx.build()
  await chat.send(text, pc)
}

function onStop() { chat.cancel() }
function onClose() { emit('close') }
function onViewInBuilder(spec: any) { emit('view-in-builder', spec) }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
}

watch(chat.messages, async () => {
  await nextTick()
  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
}, { deep: true })
</script>

<template>
  <aside class="joule-panel" aria-label="Joule chat">
    <header class="joule-header">
      <strong>Joule</strong>
      <ui5-button design="Transparent" icon="decline" data-test="joule-close" @click="onClose" />
    </header>

    <div ref="listRef" class="joule-list">
      <p v-if="chat.messages.value.length === 0" class="hint">
        Ask me to summarize your last query, or to build one.<br>
        Example: <em>"group task records by event, count completions"</em>.
      </p>
      <JouleMessage
        v-for="m in chat.messages.value"
        :key="m.id"
        :message="m"
        @view-in-builder="onViewInBuilder"
      />
    </div>

    <div class="joule-input">
      <textarea
        v-model="draft"
        rows="2"
        placeholder="Ask Joule…"
        :disabled="chat.streaming.value"
        @keydown="onKeydown"
      />
      <ui5-button
        v-if="!chat.streaming.value"
        design="Emphasized"
        data-test="joule-send"
        :disabled="!draft.trim()"
        @click="onSend"
      >Send</ui5-button>
      <ui5-button
        v-else
        design="Negative"
        data-test="joule-stop"
        @click="onStop"
      >Stop</ui5-button>
    </div>
  </aside>
</template>

<style scoped>
.joule-panel {
  display: flex; flex-direction: column;
  width: 340px; flex-shrink: 0;
  border-left: 1px solid var(--sapField_BorderColor);
  background: var(--sapBaseColor, white);
  height: 100%;
}
.joule-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.joule-list {
  flex: 1; overflow-y: auto; padding: 0.5rem 0.75rem;
}
.hint { font-size: 0.8rem; color: var(--sapNeutralTextColor); }
.joule-input {
  display: flex; gap: 0.4rem; padding: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
}
.joule-input textarea {
  flex: 1; resize: none; font: inherit; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor); border-radius: 4px;
}
</style>
