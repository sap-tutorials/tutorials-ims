<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { renderMarkdown } from '../devtoberfest-shared/render-markdown'

type State = 'loading' | 'ok' | 'empty' | 'error'

const state = ref<State>('loading')
const html = ref<string>('')
const errorMsg = ref<string>('')

async function load(): Promise<void> {
  state.value = 'loading'
  errorMsg.value = ''
  try {
    const res = await fetch('/api/devtoberfest/faq', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.status === 503) {
      state.value = 'empty'
      return
    }
    if (!res.ok) {
      errorMsg.value = `Couldn't load the FAQ (HTTP ${res.status}).`
      state.value = 'error'
      return
    }
    const data = (await res.json()) as { text?: string }
    const text = (data.text || '').trim()
    if (!text) {
      state.value = 'empty'
      return
    }
    html.value = renderMarkdown(text)
    state.value = 'ok'
  } catch {
    errorMsg.value = "Couldn't reach the Devtoberfest service."
    state.value = 'error'
  }
}

onMounted(load)
</script>

<template>
  <article class="dtf-doc-page">
    <header class="dtf-doc-header">
      <h1 class="dtf-doc-title">Devtoberfest FAQ</h1>
    </header>

    <p v-if="state === 'loading'" class="dtf-doc-loading">Loading the FAQ&hellip;</p>
    <p v-else-if="state === 'empty'" class="dtf-doc-empty">
      FAQ coming soon. Check back closer to the event.
    </p>
    <p v-else-if="state === 'error'" class="dtf-doc-error">
      {{ errorMsg }}
      <button type="button" class="dtf-doc-retry" @click="load">Retry</button>
    </p>
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify in renderMarkdown -->
    <div v-else class="dtf-doc-body" v-html="html"></div>
  </article>
</template>

<style>
/* Reuses the .dtf-doc-* styles defined in the Rules App.vue when both are
   present; duplicated here so the FAQ page is self-contained if loaded alone. */
.dtf-doc-page { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.dtf-doc-header { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 1rem; }
.dtf-doc-title { font-size: 1.75rem; margin: 0; }
.dtf-doc-body { line-height: 1.6; }
.dtf-doc-body h1, .dtf-doc-body h2, .dtf-doc-body h3 { margin-top: 1.5rem; }
.dtf-doc-body a { color: var(--sapLinkColor, #0a6ed1); }
.dtf-doc-body ul, .dtf-doc-body ol { padding-left: 1.5rem; }
.dtf-doc-loading, .dtf-doc-empty { color: var(--sapContent_LabelColor, #6a6d70); }
.dtf-doc-error {
  padding: 0.5rem 0.75rem; background: var(--sapErrorBackground, #ffeaea);
  border-left: 3px solid var(--sapNegativeColor, #aa0808); border-radius: 0 4px 4px 0;
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
}
.dtf-doc-retry {
  padding: 0.25rem 0.75rem; background: var(--sapButton_Background, #fff);
  border: 1px solid var(--sapNegativeColor, #aa0808); border-radius: 4px; cursor: pointer;
}
</style>
