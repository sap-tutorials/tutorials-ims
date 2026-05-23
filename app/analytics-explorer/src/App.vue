<script setup lang="ts">
import '@ui5/webcomponents-fiori/dist/ShellBar.js'
import '@ui5/webcomponents/dist/Title.js'
</script>

<template>
  <div class="app-shell">
    <ui5-shellbar primary-title="Analytics Explorer" />
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell { display: flex; flex-direction: column; height: 100vh; }
.content { flex: 1; overflow: hidden; }
</style>
