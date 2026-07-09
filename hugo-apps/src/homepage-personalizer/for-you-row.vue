<template>
  <div class="for-you-cards cards">
    <template v-for="item in items" :key="item.ID">
      <a v-if="linkFor(item)" :href="linkFor(item)!" class="for-you-card">
        <div class="for-you-card__body">
          <span class="for-you-card__kind">{{ kindLabel(item.kind) }}</span>
          <h3 class="for-you-card__title">{{ item.title }}</h3>
          <p v-if="item.description" class="for-you-card__desc">{{ item.description }}</p>
        </div>
      </a>
    </template>
  </div>
</template>
<script setup lang="ts">
interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}
defineProps<{ items: ForYouItem[] }>();

function kindLabel(kind: string): string {
  switch (kind) {
    case 'tutorial': return 'Tutorial';
    case 'mission':  return 'Mission';
    case 'blog':     return 'Blog';
    case 'video':    return 'Video';
    case 'shelf':    return 'Resource';
    default:         return kind || 'Resource';
  }
}

// Only http(s) URLs are permitted for external targets. Anything else
// (javascript:, data:, vbscript:, protocol-relative //evil.com) resolves
// to null → item is dropped from the list entirely (see v-if above).
// Admins own For-you candidates, but this defends against a compromised
// admin session or a data-import mistake — the personalization surface
// must never emit an active javascript: URL or a cross-origin link the
// author didn't type. Parses the candidate WITHOUT a base URL so
// protocol-relative inputs like '//evil.com' throw and get rejected —
// avoids the parser-differential where `new URL('//evil.com', origin)`
// resolves to a same-scheme cross-origin URL and passes an isHttp check.
function isHttpUrl(candidate: string): boolean {
  try {
    const u = new URL(candidate);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function linkFor(it: ForYouItem): string | null {
  const slug = it.slug ?? '';
  // Reject slugs that look like a URL scheme (contain a colon before any '/')
  // for the kinds where slug should be a plain identifier. This blocks
  // 'data:text/html,...' from becoming '/blog/data%3A...' — still same-origin
  // and non-exploitable, but 404s clutter logs and the intent was clearly
  // malicious. For 'blog' and 'video', a full http(s) URL is the only way to
  // supply an external link.
  const looksSchemey = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(slug);
  switch (it.kind) {
    case 'tutorial':
      return slug && !looksSchemey ? `/tutorials/${encodeURIComponent(slug)}/` : null;
    case 'mission':
      return slug && !looksSchemey ? `/missions/${encodeURIComponent(slug)}/` : null;
    case 'blog':
      if (slug.startsWith('https://') || slug.startsWith('http://')) {
        return isHttpUrl(slug) ? slug : null;
      }
      return slug && !looksSchemey ? `/blog/${encodeURIComponent(slug)}/` : null;
    case 'video':
      if (slug.startsWith('https://') || slug.startsWith('http://')) {
        return isHttpUrl(slug) ? slug : null;
      }
      // YouTube video IDs are alphanumeric + '-' + '_'. Anything else drops.
      return /^[A-Za-z0-9_-]{1,64}$/.test(slug) ? `https://youtu.be/${slug}` : null;
    case 'shelf':
      // Shelf targetSlug is expected to be a full URL (admin-curated).
      // Refuse anything that isn't http(s).
      return isHttpUrl(slug) ? slug : null;
    default:
      // Unknown kind → drop, don't guess.
      return null;
  }
}
</script>
