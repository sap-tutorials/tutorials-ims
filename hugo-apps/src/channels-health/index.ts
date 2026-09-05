import { createApp } from 'vue';
import ChannelsHealth from './ChannelsHealth.vue';

function boot() {
  document.querySelectorAll('[data-island="channels-health"]').forEach((el) => {
    const dataEl = document.getElementById('channels-stats-data');
    let stats: Record<string, unknown> = {};
    try { stats = JSON.parse(dataEl?.textContent || '{}'); } catch { stats = {}; }
    createApp(ChannelsHealth, { stats }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
