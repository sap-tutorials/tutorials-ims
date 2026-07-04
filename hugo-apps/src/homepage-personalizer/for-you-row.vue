<template>
  <ul class="for-you-cards">
    <li v-for="item in items" :key="item.ID">
      <a :href="linkFor(item)">
        <img v-if="item.imageUrl" :src="item.imageUrl" alt="" />
        <h3>{{ item.title }}</h3>
        <p v-if="item.description">{{ item.description }}</p>
        <span class="kind">{{ item.kind }}</span>
      </a>
    </li>
  </ul>
</template>
<script setup lang="ts">
interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}
defineProps<{ items: ForYouItem[] }>();
function linkFor(it: ForYouItem): string {
  switch (it.kind) {
    case 'tutorial': return `/tutorials/${it.slug}/`;
    case 'mission':  return `/missions/${it.slug}/`;
    case 'blog':     return it.slug.startsWith('http') ? it.slug : `/blog/${it.slug}/`;
    case 'video':    return it.slug.startsWith('http') ? it.slug : `https://youtu.be/${it.slug}`;
    default:         return it.slug;
  }
}
</script>
