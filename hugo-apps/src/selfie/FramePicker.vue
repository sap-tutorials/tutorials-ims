<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ frames: string[]; imgBase: string }>()
const emit = defineEmits<{ select: [name: string] }>()

const selected = ref<string | null>(null)

function choose(name: string) {
  selected.value = name
  emit('select', name)
}
</script>
<template>
  <ul class="frame-picker" role="listbox" aria-label="Choose an advocate frame">
    <li
      v-for="f in frames"
      :key="f"
      class="frame-thumb"
      role="option"
      tabindex="0"
      :aria-selected="f === selected"
      :class="{ 'is-selected': f === selected }"
      @click="choose(f)"
      @keydown.enter.prevent="choose(f)"
      @keydown.space.prevent="choose(f)"
    >
      <img :src="`${imgBase}/thumbnails/${f}.png`" :alt="f" loading="lazy" />
    </li>
  </ul>
</template>
