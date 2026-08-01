<script setup lang="ts">
defineProps<{ frames: string[]; imgBase: string }>()
const emit = defineEmits<{ select: [name: string] }>()
</script>
<template>
  <ul class="frame-picker" role="listbox" aria-label="Choose an advocate frame">
    <li v-for="f in frames" :key="f" class="frame-thumb" role="option" @click="emit('select', f)">
      <img :src="`${imgBase}/thumbnails/${f}.png`" :alt="f" loading="lazy" />
    </li>
  </ul>
</template>
