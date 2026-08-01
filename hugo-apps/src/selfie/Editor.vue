<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'

const props = defineProps<{ dataUrl: string }>()
const emit = defineEmits<{ restart: [] }>()

const imgEl = ref<HTMLImageElement | null>(null)
let cropper: Cropper | null = null

function initCropper() {
  destroyCropper()
  if (!props.dataUrl || !imgEl.value) return
  try {
    cropper = new Cropper(imgEl.value, {
      viewMode: 1,
      autoCropArea: 1,
      background: false,
    })
  } catch (e) {
    // Fail-soft: a cropper init failure must never crash the island.
    console.warn('[selfie] cropper init failed', e)
    cropper = null
  }
}

function destroyCropper() {
  if (cropper) {
    try { cropper.destroy() } catch { /* noop */ }
    cropper = null
  }
}

function rotate(deg: number) {
  cropper?.rotate(deg)
}

function resetCrop() {
  cropper?.reset()
}

function download() {
  const canvas = cropper?.getCroppedCanvas()
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'selfie.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

onMounted(async () => {
  await nextTick()
  initCropper()
})
onBeforeUnmount(destroyCropper)
watch(() => props.dataUrl, async () => {
  await nextTick()
  initCropper()
})
</script>
<template>
  <div class="selfie-editor">
    <div class="selfie-editor-stage">
      <img ref="imgEl" :src="dataUrl" alt="Your selfie composite — crop and rotate before downloading" />
    </div>
    <div class="selfie-editor-toolbar">
      <button type="button" class="selfie-btn" data-testid="rotate-left" @click="rotate(-90)">Rotate left</button>
      <button type="button" class="selfie-btn" data-testid="rotate-right" @click="rotate(90)">Rotate right</button>
      <button type="button" class="selfie-btn" data-testid="reset" @click="resetCrop">Reset crop</button>
      <button type="button" class="selfie-btn" data-testid="download" @click="download">Download</button>
      <button type="button" class="selfie-btn" data-testid="restart" @click="emit('restart')">Start over</button>
    </div>
  </div>
</template>
