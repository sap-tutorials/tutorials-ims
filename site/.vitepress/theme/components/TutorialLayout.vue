<script setup lang="ts">
import { useData } from 'vitepress'

const { frontmatter, page } = useData()
</script>

<template>
  <div class="tutorial-layout">
    <h1>{{ frontmatter.title }}</h1>
    <p>{{ frontmatter.description }}</p>
    <p>Level: {{ frontmatter.level }} | Time: {{ frontmatter.time }} min | Steps: {{ frontmatter.stepCount }}</p>
    <Content />
  </div>
</template>

<style scoped>
.tutorial-layout {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem;
}
</style>
