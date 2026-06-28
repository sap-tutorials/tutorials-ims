<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

interface VideoItem {
  videoId: string;
  title: string;
  thumbnail?: string;
  publishedAt?: string;
}

interface VideosResponse {
  featured?: VideoItem;
  recent?: VideoItem[];
}

const featured = ref<VideoItem | null>(null);
const recent = ref<VideoItem[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

function thumbUrl(item: VideoItem): string {
  if (item.thumbnail) return item.thumbnail;
  return `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
}

function watchUrl(videoId: string): string {
  return `https://youtube.com/watch?v=${videoId}`;
}

const recentSlice = computed(() => recent.value.slice(0, 3));

onMounted(async () => {
  try {
    const res = await fetch('/homepage/videos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: VideosResponse = await res.json();
    // Support both shaped response {featured, recent:[...]} and flat array
    if (body.featured) {
      featured.value = body.featured;
      recent.value = body.recent ?? [];
    } else if (Array.isArray(body)) {
      const arr = body as VideoItem[];
      featured.value = arr[0] ?? null;
      recent.value = arr.slice(1);
    } else {
      featured.value = null;
      recent.value = [];
    }
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="hb-video-band">
    <!-- Loading -->
    <div v-if="loading" class="hb-video-band__layout" aria-hidden="true">
      <div class="hb-video-band__featured-skel hb-video-band__skel"></div>
      <div class="hb-video-band__stack">
        <div v-for="i in 3" :key="i" class="hb-video-band__recent-skel hb-video-band__skel"></div>
      </div>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="hb-video-band__error">
      <a
        href="https://youtube.com/@sapdevs"
        target="_blank"
        rel="noopener noreferrer"
        class="hb-video-band__error-card"
      >
        <div class="hb-video-band__error-icon">&#9654;</div>
        <div class="hb-video-band__error-text">
          <strong>Watch on @sapdevs</strong>
          <span>youtube.com/@sapdevs</span>
        </div>
      </a>
    </div>

    <!-- Content -->
    <div v-else class="hb-video-band__layout">
      <!-- Featured (left column) -->
      <div class="hb-video-band__featured">
        <template v-if="featured">
          <a
            :href="watchUrl(featured.videoId)"
            target="_blank"
            rel="noopener noreferrer"
            class="hb-video-band__featured-link"
            :aria-label="'Watch: ' + featured.title"
          >
            <div class="hb-video-band__thumb-wrap">
              <img
                :src="thumbUrl(featured)"
                :alt="featured.title"
                class="hb-video-band__thumb"
                loading="lazy"
              />
              <div class="hb-video-band__play-overlay" aria-hidden="true">&#9654;</div>
            </div>
            <div class="hb-video-band__featured-info">
              <p class="hb-video-band__featured-title">{{ featured.title }}</p>
              <span class="hb-video-band__cta">Watch on YouTube &rarr;</span>
            </div>
          </a>
        </template>
        <a
          v-else
          href="https://youtube.com/@sapdevs"
          target="_blank"
          rel="noopener noreferrer"
          class="hb-video-band__error-card"
        >
          <strong>Watch on @sapdevs</strong>
        </a>
      </div>

      <!-- Recent stack (right column) -->
      <div v-if="recentSlice.length" class="hb-video-band__stack">
        <a
          v-for="(vid, idx) in recentSlice"
          :key="idx"
          :href="watchUrl(vid.videoId)"
          target="_blank"
          rel="noopener noreferrer"
          class="hb-video-band__recent-card"
          :aria-label="'Watch: ' + vid.title"
        >
          <img
            :src="thumbUrl(vid)"
            :alt="vid.title"
            class="hb-video-band__recent-thumb"
            loading="lazy"
          />
          <p class="hb-video-band__recent-title">{{ vid.title }}</p>
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hb-video-band {
  width: 100%;
}

.hb-video-band__layout {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: var(--sapContent_Gap, 1rem);
  align-items: start;
}

@media (max-width: 768px) {
  .hb-video-band__layout {
    grid-template-columns: 1fr;
  }
}

/* Skeletons */
.hb-video-band__skel {
  border-radius: 8px;
  background: linear-gradient(90deg, #f1f4f9 0%, #e6effa 50%, #f1f4f9 100%);
  background-size: 200% 100%;
  animation: hb-vid-shimmer 1.4s linear infinite;
}

.hb-video-band__featured-skel {
  aspect-ratio: 16 / 9;
}

.hb-video-band__stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.hb-video-band__recent-skel {
  height: 72px;
}

@keyframes hb-vid-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .hb-video-band__skel { animation: none; }
}

/* Featured card */
.hb-video-band__featured-link {
  display: block;
  text-decoration: none;
  color: inherit;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
}

.hb-video-band__thumb-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #000;
}

.hb-video-band__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: opacity 0.2s;
}

.hb-video-band__featured-link:hover .hb-video-band__thumb {
  opacity: 0.85;
}

.hb-video-band__play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3rem;
  color: rgba(255, 255, 255, 0.85);
  pointer-events: none;
}

.hb-video-band__featured-info {
  padding: 0.75rem 1rem;
  background: var(--sapBaseColor, #fff);
}

.hb-video-band__featured-title {
  margin: 0 0 0.4rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  line-height: 1.35;
}

.hb-video-band__cta {
  font-size: 0.85rem;
  color: var(--sapLinkColor, #0070f2);
  font-weight: 600;
}

/* Recent stack */
.hb-video-band__recent-card {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  text-decoration: none;
  color: inherit;
  padding: 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  background: var(--sapBaseColor, #fff);
  transition: background 0.15s;
}

.hb-video-band__recent-card:hover {
  background: var(--sapHoverColor, #f5f8ff);
}

.hb-video-band__recent-thumb {
  width: 96px;
  height: 54px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.hb-video-band__recent-title {
  margin: 0;
  font-size: 0.875rem;
  color: var(--sapTextColor, #32363a);
  line-height: 1.35;
  font-weight: 500;
}

/* Error card */
.hb-video-band__error {
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
}

.hb-video-band__error-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem 2rem;
  border-radius: 8px;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  background: var(--sapBaseColor, #fff);
  text-decoration: none;
  color: inherit;
  min-width: 240px;
}

.hb-video-band__error-icon {
  font-size: 2.5rem;
  color: var(--sapLinkColor, #0070f2);
}

.hb-video-band__error-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.hb-video-band__error-text strong {
  font-size: 1rem;
  color: var(--sapTextColor, #32363a);
}
</style>
