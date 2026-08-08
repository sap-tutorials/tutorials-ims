<script setup lang="ts">
import { ref } from 'vue'
import type { StickerDef } from './stickers'
import { EMOJI } from './stickers'

const props = defineProps<{ stickers: StickerDef[]; imgBase: string }>()
const emit = defineEmits<{ 'add-sticker': [src: string]; 'add-emoji': [char: string] }>()

const tab = ref<'brand' | 'emoji'>('brand')
function srcOf(s: StickerDef) { return `${props.imgBase}/stickers/${s.file}.png` }
</script>
<template>
  <div class="sticker-picker">
    <div class="sticker-tabs" role="tablist">
      <button
        type="button" role="tab" data-testid="tab-brand"
        :aria-selected="tab === 'brand'" :class="{ 'is-active': tab === 'brand' }"
        @click="tab = 'brand'"
      >Stickers</button>
      <button
        type="button" role="tab" data-testid="tab-emoji"
        :aria-selected="tab === 'emoji'" :class="{ 'is-active': tab === 'emoji' }"
        @click="tab = 'emoji'"
      >Emoji</button>
    </div>

    <ul v-if="tab === 'brand'" class="sticker-grid" role="listbox" aria-label="Stickers">
      <li v-if="!stickers.length" class="sticker-empty">No stickers available.</li>
      <li
        v-for="s in stickers" :key="s.name" class="sticker-thumb"
        role="option" tabindex="0"
        @click="emit('add-sticker', srcOf(s))"
        @keydown.enter.prevent="emit('add-sticker', srcOf(s))"
      >
        <img :src="srcOf(s)" :alt="s.name" loading="lazy" />
      </li>
    </ul>

    <ul v-else class="sticker-grid emoji-grid" role="listbox" aria-label="Emoji">
      <li v-for="e in EMOJI" :key="e">
        <button type="button" class="emoji-btn" @click="emit('add-emoji', e)">{{ e }}</button>
      </li>
    </ul>
  </div>
</template>
