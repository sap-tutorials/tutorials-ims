import { createApp } from 'vue';
import EventsBand from './EventsBand.vue';
import VideoBand from './VideoBand.vue';
import CommunityLane from './CommunityLane.vue';

function mount(selector: string, component: any) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  const props: Record<string, any> = {};
  if (el.dataset.mode) props.mode = el.dataset.mode;
  createApp(component, props).mount(el);
}

mount('[data-island="events"]', EventsBand);
mount('[data-island="videos"]', VideoBand);
mount('[data-island="community"]', CommunityLane);
mount('[data-island="events-calendar"]', EventsBand);  // reused on /connect/
