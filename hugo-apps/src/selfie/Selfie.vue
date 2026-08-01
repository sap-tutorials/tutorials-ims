<script setup lang="ts">
import { ref } from 'vue'
import type { MountConfig } from './types'
import FramePicker from './FramePicker.vue'
import Uploader from './Uploader.vue'
defineProps<{ config: MountConfig }>()
const selectedFrame = ref<string | null>(null)
const composite = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
defineExpose({ selectedFrame, composite })

function onResult(dataUrl: string) {
  errorMsg.value = null
  composite.value = dataUrl
}
function onError(message: string) {
  errorMsg.value = message
}
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is uploaded to build the image and is <strong>not stored</strong>.</p>

    <template v-if="!composite">
      <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
      <Uploader :api-upload="config.apiUpload" :selected-frame="selectedFrame" @result="onResult" @error="onError" />
    </template>

    <p v-if="errorMsg" class="selfie-error" role="alert">{{ errorMsg }}</p>

    <!-- Editor (crop/rotate/download) wired in Task 4; placeholder preview for now -->
    <img v-if="composite" :src="composite" alt="Your selfie composite" class="selfie-composite-preview" />
  </div>
</template>
