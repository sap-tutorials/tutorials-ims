<script setup lang="ts">
import { useSound } from './useSound'
const props = defineProps<{ imgBase: string }>()
const { enabled, toggle } = useSound(`${props.imgBase}/music/8bit.mp3`)
</script>
<template>
  <button class="s-sound" :aria-pressed="enabled" @click="toggle"
          :title="enabled ? 'Mute 8-bit music' : 'Play 8-bit music'">
    <img :src="`${imgBase}/arcade/menu/sound.png`" alt="" /> {{ enabled ? 'ON' : 'OFF' }}
  </button>
</template>
