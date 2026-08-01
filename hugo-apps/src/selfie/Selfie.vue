<script setup lang="ts">
import { ref } from 'vue'
import type { MountConfig } from './types'
import FramePicker from './FramePicker.vue'
defineProps<{ config: MountConfig }>()
const selectedFrame = ref<string | null>(null)
defineExpose({ selectedFrame })
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is uploaded to build the image and is <strong>not stored</strong>.</p>
    <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
  </div>
</template>
