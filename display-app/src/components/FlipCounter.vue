<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  value: number
  size?: 'hero' | 'sidebar'
  color?: 'hero' | 'accent'
}>()

const chars = computed(() =>
  props.value.toLocaleString().split('').map(ch => ({
    char: ch,
    isDigit: /\d/.test(ch),
    digit: parseInt(ch) || 0,
  }))
)
</script>

<template>
  <div class="flip-counter" :class="[size ?? 'hero', color === 'hero' || (!color && size !== 'sidebar') ? 'hero-color' : 'accent']">
    <template v-for="(item, i) in chars" :key="i">
      <div v-if="item.isDigit" class="fc-slot">
        <div class="fc-roll" :style="{ transform: `translateY(${-item.digit * 10}%)` }">
          <div v-for="d in 10" :key="d" class="fc-num">{{ d - 1 }}</div>
        </div>
      </div>
      <div v-else class="flip-sep"><span>{{ item.char }}</span></div>
    </template>
  </div>
</template>

<style>
.flip-counter {
  display: inline-flex;
  align-items: center;
  gap: 0.08em;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.fc-slot {
  overflow: hidden;
  border-radius: 0.06em;
  background: var(--d-flap-bg);
  border: 1px solid var(--d-flap-border);
}

.fc-roll {
  transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.fc-num {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  user-select: none;
}

.flip-sep {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  width: 0.35em;
}

/* ═══════ Hero size ═══════ */
.flip-counter.hero .fc-slot {
  width: clamp(3.8rem, 8.5vw, 8.5rem);
  height: clamp(6rem, 13vw, 13rem);
}
.flip-counter.hero .fc-num {
  width: clamp(3.8rem, 8.5vw, 8.5rem);
  height: clamp(6rem, 13vw, 13rem);
  font-size: clamp(5rem, 12vw, 12rem);
}
.flip-counter.hero .flip-sep {
  font-size: clamp(3rem, 7vw, 7rem);
}

/* ═══════ Sidebar size ═══════ */
.flip-counter.sidebar .fc-slot {
  width: clamp(1.6rem, 3.2vw, 2.8rem);
  height: clamp(2.5rem, 4.8vw, 4.2rem);
}
.flip-counter.sidebar .fc-num {
  width: clamp(1.6rem, 3.2vw, 2.8rem);
  height: clamp(2.5rem, 4.8vw, 4.2rem);
  font-size: clamp(2rem, 4vw, 3.5rem);
}
.flip-counter.sidebar .flip-sep {
  font-size: clamp(1.2rem, 2.5vw, 2.2rem);
}

/* ═══════ Color: hero (white on gradient) ═══════ */
.flip-counter.hero-color .fc-num,
.flip-counter.hero-color .flip-sep {
  color: var(--d-hero-text);
}
.flip-counter.hero-color .fc-slot {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
}

/* ═══════ Color: accent ═══════ */
.flip-counter.accent .fc-num,
.flip-counter.accent .flip-sep {
  color: var(--d-accent);
}
</style>
