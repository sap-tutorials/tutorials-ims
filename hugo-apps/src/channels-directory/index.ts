import { createApp } from 'vue';
import ChannelsDirectory from './ChannelsDirectory.vue';

function boot() {
  document.querySelectorAll('[data-island="channels-directory"]').forEach((el) => {
    const dataEl = document.getElementById('channels-data');
    let channels: unknown[] = [];
    try { channels = JSON.parse(dataEl?.textContent || '[]'); } catch { channels = []; }
    const collectionsEl = document.getElementById('channel-collections-data');
    let collections: unknown[] = [];
    try { collections = JSON.parse(collectionsEl?.textContent || '[]'); } catch { collections = []; }
    createApp(ChannelsDirectory, { channels, collections }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
