<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface Advocate {
  ID?: string | number;
  name?: string;
  fullName?: string;
  region?: string;
  slug?: string;
  photoUrl?: string;
}

interface BlogPost {
  title: string;
  url: string;
  publishedAt?: string;
  author?: string;
}

interface NewsItem {
  title: string;
  url: string;
  publishedAt?: string;
}

// Three independent fetch states
const advocates = ref<Advocate[]>([]);
const blogs = ref<BlogPost[]>([]);
const news = ref<NewsItem[]>([]);

const advLoading = ref(true);
const blogLoading = ref(true);
const newsLoading = ref(true);

const advError = ref<string | null>(null);
const blogError = ref<string | null>(null);
const newsError = ref<string | null>(null);

function formatDate(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function advocateName(a: Advocate): string {
  return a.fullName || a.name || 'SAP Developer Advocate';
}

/** Pick up to `n` random elements from an array (no shuffle mutation). */
function pickRandom<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

onMounted(() => {
  // Advocates
  fetch('/api/advocates', { headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list: Advocate[] = Array.isArray(body.advocates) ? body.advocates : Array.isArray(body) ? body : [];
      advocates.value = pickRandom(list, 3);
    })
    .catch((e) => { advError.value = (e as Error).message; })
    .finally(() => { advLoading.value = false; });

  // Community blogs
  fetch('/api/homepage/communityBlogs')
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      blogs.value = Array.isArray(body.value) ? body.value.slice(0, 3)
        : Array.isArray(body) ? body.slice(0, 3) : [];
    })
    .catch((e) => { blogError.value = (e as Error).message; })
    .finally(() => { blogLoading.value = false; });

  // SAP News
  fetch('/api/homepage/news')
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      news.value = Array.isArray(body.value) ? body.value.slice(0, 2)
        : Array.isArray(body) ? body.slice(0, 2) : [];
    })
    .catch((e) => { newsError.value = (e as Error).message; })
    .finally(() => { newsLoading.value = false; });
});
</script>

<template>
  <div class="hb-community-lane">
    <!-- Advocates column -->
    <div class="hb-community-lane__col">
      <h3 class="hb-community-lane__col-title">Developer Advocates</h3>

      <div v-if="advLoading" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="hb-community-lane__skel hb-community-lane__skel--adv"></div>
      </div>

      <div v-else-if="advError || !advocates.length" class="hb-community-lane__empty">
        <a
          href="https://developers.sap.com/developer-advocates.html"
          class="hb-community-lane__empty-link"
        >Meet the Developer Advocates &rarr;</a>
      </div>

      <div v-else class="hb-community-lane__adv-list">
        <a
          v-for="adv in advocates"
          :key="adv.ID ?? adv.slug ?? adv.name"
          :href="adv.slug ? `/developer-advocates/#${adv.slug}` : '/developer-advocates/'"
          class="hb-community-lane__adv-card"
        >
          <img
            v-if="adv.slug"
            :src="`/api/advocates/${adv.slug}/photo`"
            :alt="advocateName(adv)"
            class="hb-community-lane__adv-photo"
            loading="lazy"
            @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
          />
          <div v-else class="hb-community-lane__adv-avatar" aria-hidden="true">
            {{ (advocateName(adv)[0] || '?').toUpperCase() }}
          </div>
          <div class="hb-community-lane__adv-info">
            <span class="hb-community-lane__adv-name">{{ advocateName(adv) }}</span>
            <span v-if="adv.region" class="hb-community-lane__adv-region">{{ adv.region }}</span>
          </div>
        </a>
      </div>
    </div>

    <!-- Community blogs column -->
    <div class="hb-community-lane__col">
      <h3 class="hb-community-lane__col-title">Community Blogs</h3>

      <div v-if="blogLoading" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="hb-community-lane__skel hb-community-lane__skel--blog"></div>
      </div>

      <div v-else-if="blogError || !blogs.length" class="hb-community-lane__empty">
        <a
          href="https://community.sap.com/t5/blogs/ct-p/blog-sap"
          target="_blank"
          rel="noopener noreferrer"
          class="hb-community-lane__empty-link"
        >Browse SAP community blogs &rarr;</a>
      </div>

      <ul v-else class="hb-community-lane__blog-list">
        <li v-for="(post, idx) in blogs" :key="idx" class="hb-community-lane__blog-item">
          <a
            :href="post.url"
            target="_blank"
            rel="noopener noreferrer"
            class="hb-community-lane__blog-link"
          >{{ post.title }}</a>
          <span v-if="post.publishedAt || post.author" class="hb-community-lane__blog-meta">
            <template v-if="post.author">{{ post.author }}</template>
            <template v-if="post.author && post.publishedAt"> &middot; </template>
            <template v-if="post.publishedAt">{{ formatDate(post.publishedAt) }}</template>
          </span>
        </li>
      </ul>
    </div>

    <!-- SAP News column -->
    <div class="hb-community-lane__col">
      <h3 class="hb-community-lane__col-title">SAP News</h3>

      <div v-if="newsLoading" aria-hidden="true">
        <div v-for="i in 2" :key="i" class="hb-community-lane__skel hb-community-lane__skel--news"></div>
      </div>

      <div v-else-if="newsError || !news.length" class="hb-community-lane__empty">
        <a
          href="https://news.sap.com/"
          target="_blank"
          rel="noopener noreferrer"
          class="hb-community-lane__empty-link"
        >Visit news.sap.com &rarr;</a>
      </div>

      <ul v-else class="hb-community-lane__news-list">
        <li v-for="(item, idx) in news" :key="idx" class="hb-community-lane__news-item">
          <a
            :href="item.url"
            target="_blank"
            rel="noopener noreferrer"
            class="hb-community-lane__news-link"
          >{{ item.title }}</a>
          <span v-if="item.publishedAt" class="hb-community-lane__news-date">
            {{ formatDate(item.publishedAt) }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.hb-community-lane {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sapContent_Gap, 1rem);
  width: 100%;
  align-items: start;
}

@media (max-width: 900px) {
  .hb-community-lane {
    grid-template-columns: 1fr;
  }
}

.hb-community-lane__col-title {
  font-size: 1rem;
  font-weight: 700;
  margin: 0 0 0.75rem;
  color: var(--sapTextColor, #32363a);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.8rem;
}

/* Skeletons */
.hb-community-lane__skel {
  border-radius: 6px;
  margin-bottom: 0.5rem;
  background: linear-gradient(90deg, #f1f4f9 0%, #e6effa 50%, #f1f4f9 100%);
  background-size: 200% 100%;
  animation: hb-comm-shimmer 1.4s linear infinite;
}

.hb-community-lane__skel--adv  { height: 52px; }
.hb-community-lane__skel--blog { height: 40px; }
.hb-community-lane__skel--news { height: 48px; margin-bottom: 0.75rem; }

@keyframes hb-comm-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .hb-community-lane__skel { animation: none; }
}

/* Empty / fallback */
.hb-community-lane__empty {
  padding: 0.75rem 0;
}

.hb-community-lane__empty-link {
  color: var(--sapLinkColor, #0070f2);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
}

.hb-community-lane__empty-link:hover {
  text-decoration: underline;
}

/* Advocate cards */
.hb-community-lane__adv-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.hb-community-lane__adv-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  background: var(--sapBaseColor, #fff);
  text-decoration: none;
  color: inherit;
  transition: background 0.15s;
}

.hb-community-lane__adv-card:hover {
  background: var(--sapHoverColor, #f5f8ff);
}

.hb-community-lane__adv-photo {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.hb-community-lane__adv-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--sapButton_Emphasized_Background, #0070f2);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  font-weight: 700;
  flex-shrink: 0;
}

.hb-community-lane__adv-info {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.hb-community-lane__adv-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hb-community-lane__adv-region {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

/* Blog list */
.hb-community-lane__blog-list,
.hb-community-lane__news-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.hb-community-lane__blog-item,
.hb-community-lane__news-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
}

.hb-community-lane__blog-item:last-child,
.hb-community-lane__news-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.hb-community-lane__blog-link,
.hb-community-lane__news-link {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  text-decoration: none;
  line-height: 1.35;
}

.hb-community-lane__blog-link:hover,
.hb-community-lane__news-link:hover {
  color: var(--sapLinkColor, #0070f2);
  text-decoration: underline;
}

.hb-community-lane__blog-meta,
.hb-community-lane__news-date {
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}
</style>
