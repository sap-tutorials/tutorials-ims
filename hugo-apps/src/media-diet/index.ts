import { createApp } from 'vue';
import MediaDiet from './MediaDiet.vue';

function boot() {
  document.querySelectorAll('[data-island="media-diet"]').forEach((el) => {
    const dataEl = document.getElementById('media-diet-channels-data');
    let channels: unknown[] = [];
    try { channels = JSON.parse(dataEl?.textContent || '[]'); } catch { channels = []; }
    // PHASE 2 SEAM: signed-in path would check /auth/user here (body.authenticated === true,
    // NOT r.ok), then call GET /api/media-diet/my-picks to infer channels from completions.
    // The anon picker (channels prop) is the complete Phase 1 experience.
    createApp(MediaDiet, { channels }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
