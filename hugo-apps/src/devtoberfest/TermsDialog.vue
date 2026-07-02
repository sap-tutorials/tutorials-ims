<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { csrfFetch } from '@shared/csrf-fetch'
import type { TermsResponse } from './types'

const props = defineProps<{
  open: boolean
  apiTerms: string
  apiJoin: string
  imgKasimir: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'joined'): void
}>()

type LoadState = 'idle' | 'loading' | 'ok' | 'error'

const loadState = ref<LoadState>('idle')
const text = ref<string>('')
const version = ref<number>(0)
const errorMsg = ref<string>('')
const scrollPercent = ref<number>(0)
const submitting = ref<boolean>(false)
const bodyEl = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)

const canAccept = computed<boolean>(
  () => scrollPercent.value >= 95 && loadState.value === 'ok' && !submitting.value
)

async function loadTerms(): Promise<void> {
  loadState.value = 'loading'
  errorMsg.value = ''
  scrollPercent.value = 0
  try {
    const res = await fetch(props.apiTerms, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      console.warn('[devtoberfest] /terms', res.status)
      errorMsg.value = `Couldn't load the terms (HTTP ${res.status}).`
      loadState.value = 'error'
      return
    }
    const data = (await res.json()) as TermsResponse
    text.value = data.text || ''
    version.value = data.version || 0
    loadState.value = 'ok'
    // Defensive: if content fits the viewport (no scroll), enable button immediately.
    // Use rAF + nextTick so the body element is mounted and measured.
    requestAnimationFrame(() => {
      nextTick(() => {
        const el = bodyEl.value
        if (el && el.scrollHeight <= el.clientHeight) {
          scrollPercent.value = 100
        }
      })
    })
  } catch (err) {
    console.warn('[devtoberfest] /terms failed', err)
    errorMsg.value = "Couldn't reach the Devtoberfest service."
    loadState.value = 'error'
  }
}

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  const { scrollTop, scrollHeight, clientHeight } = el
  const max = scrollHeight - clientHeight
  scrollPercent.value =
    max <= 0 ? 100 : Math.min(100, Math.round((scrollTop / max) * 100))
}

async function onAccept(): Promise<void> {
  if (!canAccept.value) return
  submitting.value = true
  try {
    const res = await csrfFetch(props.apiJoin, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ termsVersion: version.value }),
    })
    if (res.status === 201 || res.status === 409) {
      // 201 = success; 409 = idempotent duplicate (already joined) — treat as success.
      emit('joined')
      return
    }
    if (res.status === 412) {
      // Terms bumped while dialog was open. Reload and force re-scroll.
      alert('The terms were updated. Please re-read the new version.')
      await loadTerms()
      // Reset scroll position so the user must re-scroll.
      if (bodyEl.value) bodyEl.value.scrollTop = 0
      scrollPercent.value = 0
      return
    }
    if (res.status === 401) {
      // No usable session. Defer to shellbar login flow.
      alert('Please log in via the user menu (top-right) to join.')
      emit('close')
      return
    }
    console.warn('[devtoberfest] /join', res.status)
    alert(`Couldn't complete sign-up (HTTP ${res.status}). Please try again.`)
  } catch (err) {
    console.warn('[devtoberfest] /join failed', err)
    alert("Couldn't reach the Devtoberfest service. Please try again.")
  } finally {
    submitting.value = false
  }
}

function onClose(): void {
  emit('close')
}

function onBackdropClick(): void {
  onClose()
}

// Lazy-fetch /terms when the dialog opens; reset state when it closes.
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      loadTerms()
      await nextTick()
      dialogEl.value?.focus()
    } else {
      // Reset so the next open re-fetches fresh terms.
      loadState.value = 'idle'
      text.value = ''
      version.value = 0
      errorMsg.value = ''
      scrollPercent.value = 0
      submitting.value = false
    }
  }
)
</script>

<template>
  <div
    v-if="open"
    class="dtf-dialog-backdrop"
    role="presentation"
    @click.self="onBackdropClick"
  >
    <div
      ref="dialogEl"
      class="dtf-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dtf-dialog-title"
      tabindex="-1"
    >
      <header class="dtf-dialog-header">
        <div class="dtf-dialog-brand">
          <img
            v-if="imgKasimir"
            :src="imgKasimir"
            alt=""
            class="dtf-dialog-kasimir"
            aria-hidden="true"
          />
          <div>
            <p class="dtf-dialog-eyebrow">DEVTOBERFEST &middot; CONTENTS RULES</p>
            <h2 id="dtf-dialog-title" class="dtf-dialog-title">
              Before we play together
            </h2>
          </div>
        </div>
        <span v-if="version" class="dtf-dialog-version">v{{ version }}</span>
      </header>

      <div
        ref="bodyEl"
        class="dtf-dialog-body"
        @scroll="onScroll"
      >
        <p v-if="loadState === 'loading'" class="dtf-dialog-msg">
          Loading the terms&hellip;
        </p>
        <p v-else-if="loadState === 'error'" class="dtf-dialog-msg dtf-dialog-error">
          {{ errorMsg }}
          <button class="dtf-dialog-retry" type="button" @click="loadTerms">
            Retry
          </button>
        </p>
        <div v-else-if="loadState === 'ok'" class="dtf-dialog-markdown">{{ text }}</div>
      </div>

      <footer class="dtf-dialog-footer">
        <div
          class="dtf-dialog-progress"
          :style="{ '--dtf-progress': scrollPercent + '%' }"
          :aria-valuenow="scrollPercent"
          aria-valuemin="0"
          aria-valuemax="100"
          role="progressbar"
          aria-label="Scroll progress"
        ></div>
        <div class="dtf-dialog-actions">
          <button
            type="button"
            class="dtf-dialog-cancel"
            :disabled="submitting"
            @click="onClose"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dtf-dialog-accept"
            :disabled="!canAccept"
            @click="onAccept"
          >
            {{ submitting ? 'Joining…' : 'Accept & Join' }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
