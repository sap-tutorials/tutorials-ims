<script setup lang="ts">
import type { RecentEvent } from '../event-stream'

defineProps<{
  events: readonly RecentEvent[]
  visible: boolean
}>()

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ago`
}
</script>

<template>
  <div class="activity-ticker" :class="{ visible }">
    <div class="ticker-track">
      <div class="ticker-content">
        <span v-for="(ev, i) in events" :key="ev.timestamp + '-' + i" class="ticker-item">
          <span class="ticker-dot"></span>
          <span class="ticker-name">{{ ev.name }}</span>
          <span class="ticker-plus">+1</span>
          <span class="ticker-time">{{ timeAgo(ev.timestamp) }}</span>
        </span>
        <span v-for="(ev, i) in events" :key="'dup-' + ev.timestamp + '-' + i" class="ticker-item" aria-hidden="true">
          <span class="ticker-dot"></span>
          <span class="ticker-name">{{ ev.name }}</span>
          <span class="ticker-plus">+1</span>
          <span class="ticker-time">{{ timeAgo(ev.timestamp) }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style>
.activity-ticker {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 48px;
  background: var(--d-ticker-bg);
  border-top: 1px solid var(--d-border);
  display: flex;
  align-items: center;
  z-index: 50;
  overflow: hidden;
  opacity: 0;
  transform: translateY(100%);
  transition: opacity 0.4s ease, transform 0.4s ease;
}

.activity-ticker.visible {
  opacity: 1;
  transform: translateY(0);
}

.ticker-track {
  width: 100%;
  overflow: hidden;
}

.ticker-content {
  display: inline-flex;
  white-space: nowrap;
  animation: ticker-scroll 30s linear infinite;
}

.ticker-item {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 2rem;
  font-size: 0.9375rem;
  font-family: var(--sapFontFamily);
}

.ticker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--d-ticker-dot);
  animation: dot-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}

.ticker-name {
  font-weight: 600;
  color: var(--d-text);
}

.ticker-plus {
  font-weight: 700;
  color: var(--d-accent);
  font-size: 0.8125rem;
}

.ticker-time {
  color: var(--d-text-dim);
  font-size: 0.75rem;
}

@keyframes ticker-scroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.7); }
}
</style>
