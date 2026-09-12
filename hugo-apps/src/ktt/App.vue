<script setup lang="ts">
import { ref } from 'vue';
import KasimirStage from './components/KasimirStage.vue';
const props = defineProps<{ apiUrl: string; lessons: any }>();
const screen = ref<'landing'|'map'|'lesson'|'results'>('landing');
</script>
<template>
  <div class="ktt-root" :data-screen="screen">
    <section v-if="screen === 'landing'" class="ktt-landing">
      <KasimirStage mood="idle" />
      <h1>Professor Kasimir Teaches TLAs</h1>
      <p>SAP has more three-letter acronyms than a cat has naps. Let's fix that.</p>
      <button data-testid="ktt-start" @click="screen = 'map'">Start</button>
    </section>
    <!-- map / lesson / results mounted in later tasks -->
  </div>
</template>
