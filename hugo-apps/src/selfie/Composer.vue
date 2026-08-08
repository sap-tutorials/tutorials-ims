<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { buildStage, type SelfieStage } from './compose'
import StickerPicker from './StickerPicker.vue'
import { CAPTION_PLACEHOLDER } from './stickers'
import type { StickerDef } from './stickers'

const props = defineProps<{
  rawPhoto: Blob
  cutout: Blob | null
  removeBg: boolean
  segmenting: boolean
  frameName: string
  imgBase: string
  stickers: StickerDef[]
}>()
const emit = defineEmits<{
  export: [blob: Blob]
  fallback: [blob: Blob]
  'update:removeBg': [value: boolean]
  segment: []
}>()

const stageEl = ref<HTMLDivElement | null>(null)
let stage: SelfieStage | null = null
const selectedKind = ref<'none' | 'sticker' | 'caption'>('none')
const captionText = ref('')

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

function urlToImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = src
  })
}

// The blob that should currently be shown: the segmented cutout when the user
// wants the background removed and it is ready, otherwise the raw photo.
function effectiveBlob(): Blob {
  return props.removeBg && props.cutout ? props.cutout : props.rawPhoto
}

onMounted(async () => {
  if (!stageEl.value) return
  try {
    stage = await buildStage(stageEl.value, `${props.imgBase}/frames/${props.frameName}.png`)
    stage.onSelectionChange((k) => { selectedKind.value = k as 'none' | 'sticker' | 'caption' })
    stage.addCutout(await blobToImage(effectiveBlob()))
  } catch (e) {
    // Fail-soft: stage init failed → let the parent offer a plain download.
    console.warn('[selfie] stage init failed', e)
    emit('fallback', effectiveBlob())
  }
})
onBeforeUnmount(() => { try { stage?.destroy() } catch { /* noop */ } })

// Live toggle: when removeBg or the cached cutout changes, swap the stage
// bitmap in place (keeps the user's drag/scale/rotate). If the user wants the
// background removed but it hasn't been computed yet, ask the parent to run it.
watch(() => [props.removeBg, props.cutout] as const, async () => {
  if (!stage) return
  if (props.removeBg && !props.cutout) {
    if (!props.segmenting) emit('segment')
    return // wait for the cutout to arrive; this watcher re-fires when it does.
  }
  try {
    stage.setImage(await blobToImage(effectiveBlob()))
  } catch (e) {
    console.warn('[selfie] image swap failed', e)
  }
})

async function onAddSticker(src: string) {
  if (!stage) return
  try {
    const img = await urlToImage(src)
    stage.addSticker(img)
  } catch (e) {
    console.warn('[selfie] sticker load failed', e)
  }
}

function onAddEmoji(char: string) {
  if (!stage) return
  stage.addEmoji(char)
}

function onAddCaption() {
  if (!stage) return
  const existed = stage.hasCaption()
  stage.addCaption(CAPTION_PLACEHOLDER)
  if (!existed) captionText.value = CAPTION_PLACEHOLDER
}

function onCaptionInput(e: Event) {
  if (!stage) return
  captionText.value = (e.target as HTMLInputElement).value
  stage.updateCaption(captionText.value)
}

function onDelete() {
  if (!stage) return
  stage.deleteSelected()
}

async function doExport() {
  if (!stage) return emit('fallback', effectiveBlob())
  try { emit('export', await stage.exportPng()) }
  catch { emit('fallback', effectiveBlob()) }
}
</script>
<template>
  <div class="selfie-composer">
    <div class="selfie-stage-wrap">
      <div ref="stageEl" class="selfie-stage"></div>
      <p v-if="segmenting" class="selfie-stage-overlay" role="status">Removing the background&hellip;</p>
    </div>
    <div class="selfie-editor-toolbar">
      <label class="selfie-toggle">
        <input
          type="checkbox" :checked="removeBg" :disabled="segmenting"
          data-testid="remove-bg-compose"
          @change="emit('update:removeBg', ($event.target as HTMLInputElement).checked)"
        />
        Remove background
      </label>
      <StickerPicker :stickers="stickers" :img-base="imgBase" @add-sticker="onAddSticker" @add-emoji="onAddEmoji" />
      <button type="button" class="selfie-btn" data-testid="add-caption" @click="onAddCaption">Add caption</button>
      <input
        type="text" class="selfie-caption-input" data-testid="caption-input"
        :disabled="selectedKind !== 'caption'" :value="captionText"
        @input="onCaptionInput" placeholder="Caption text"
      />
      <button
        type="button" class="selfie-btn selfie-btn--danger" data-testid="delete-overlay"
        :disabled="selectedKind === 'none'" @click="onDelete"
      >Delete</button>
      <button type="button" class="selfie-btn" data-testid="export" :disabled="segmenting" @click="doExport">Export</button>
    </div>
  </div>
</template>
