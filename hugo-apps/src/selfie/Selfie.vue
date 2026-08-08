<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import type { MountConfig, SelfieStep } from './types'
import FramePicker from './FramePicker.vue'
import Capture from './Capture.vue'
import Composer from './Composer.vue'
import ExportBar from './ExportBar.vue'
import { removeBackground } from './segment'

defineProps<{ config: MountConfig }>()

const step = ref<SelfieStep>('capture')
const selectedFrame = ref<string | null>(null)
const removeBg = ref(true) // ON by default — the tool removes the background unless the user opts out.
const rawPhoto = ref<Blob | null>(null) // the untouched capture, always kept so the toggle can show it.
const cutout = ref<Blob | null>(null) // cached segmented result; null when opted out or segmentation failed.
const finalImage = ref<Blob | null>(null)
const finalUrl = ref('')
const errorMsg = ref<string | null>(null)
const segmentProgress = ref(0)
const segmenting = ref(false)

async function onPhoto(blob: Blob) {
  errorMsg.value = null
  rawPhoto.value = blob
  if (!removeBg.value) {
    // Opted out: skip the ~76MB model entirely and compose the full photo.
    cutout.value = null
    step.value = 'compose'
    return
  }
  segmenting.value = true
  step.value = 'segment'
  try {
    const { blob: cut, removed } = await removeBackground(blob, (p) => { segmentProgress.value = p })
    if (removed) {
      cutout.value = cut
    } else {
      // Fail-soft: fall back to the full photo AND flip the toggle off so the
      // checkbox stays honest about what's actually shown.
      cutout.value = null
      removeBg.value = false
      errorMsg.value = "Couldn't remove the background — using your full photo."
    }
    step.value = 'compose'
  } catch {
    errorMsg.value = 'Something went wrong processing your photo. Please try again.'
    step.value = 'capture'
  } finally {
    segmenting.value = false
  }
}

function setFinal(blob: Blob) {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
  finalImage.value = blob
  finalUrl.value = URL.createObjectURL(blob)
  step.value = 'export'
}

function onExport(blob: Blob) { setFinal(blob) }
function onFallback(blob: Blob) { setFinal(blob) }
function onError(msg: string) { errorMsg.value = msg }

// Segment on demand when the user flips "remove background" ON at the compose
// step having started with it off (or after a capture-time failure). Runs at
// most once — the result is cached in `cutout` and reused on later flips.
async function onDemandSegment() {
  if (!rawPhoto.value || cutout.value || segmenting.value) return
  segmenting.value = true
  segmentProgress.value = 0
  errorMsg.value = null
  try {
    const { blob: cut, removed } = await removeBackground(rawPhoto.value, (p) => { segmentProgress.value = p })
    if (removed) {
      cutout.value = cut
    } else {
      // Fail-soft: keep the full photo and flip the toggle back off so it stays honest.
      removeBg.value = false
      errorMsg.value = "Couldn't remove the background — using your full photo."
    }
  } catch {
    removeBg.value = false
    errorMsg.value = "Couldn't remove the background — using your full photo."
  } finally {
    segmenting.value = false
  }
}

function restart() {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
  finalUrl.value = ''
  step.value = 'capture'
  removeBg.value = true
  rawPhoto.value = null
  cutout.value = null
  finalImage.value = null
  errorMsg.value = null
  segmentProgress.value = 0
}

onBeforeUnmount(() => {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
})
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is processed entirely on your device &mdash; it <strong>never leaves your browser</strong>.</p>

    <p v-if="errorMsg" class="selfie-error" role="alert">{{ errorMsg }}</p>

    <template v-if="step === 'capture'">
      <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
      <label v-if="selectedFrame" class="selfie-toggle">
        <input type="checkbox" v-model="removeBg" data-testid="remove-bg-capture" />
        Remove my background
      </label>
      <Capture v-if="selectedFrame" @photo="onPhoto" @error="onError" />
      <p v-else class="selfie-busy">Pick an advocate frame above to start.</p>
    </template>

    <p v-else-if="step === 'segment'" class="selfie-busy" role="status">
      Removing the background&hellip; {{ Math.round(segmentProgress * 100) }}%
    </p>

    <Composer
      v-else-if="step === 'compose' && rawPhoto && selectedFrame"
      :raw-photo="rawPhoto" :cutout="cutout" :remove-bg="removeBg" :segmenting="segmenting"
      :frame-name="selectedFrame" :img-base="config.imgBase"
      @update:remove-bg="removeBg = $event" @segment="onDemandSegment"
      @export="onExport" @fallback="onFallback"
    />

    <template v-else-if="step === 'export' && finalImage">
      <img class="selfie-final" :src="finalUrl" alt="Your finished selfie" />
      <ExportBar :image="finalImage" @restart="restart" />
    </template>
  </div>
</template>
