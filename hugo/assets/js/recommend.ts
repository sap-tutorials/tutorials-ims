// hugo/assets/js/recommend.ts
// Personalized "What's next" — fetches /api/recommendations and swaps the
// server-rendered static rail cards on success. Silent no-op on any failure.
//
// Gated on [data-recommend-slug] presence — safe import on every page.

interface RecCard {
  slug: string;
  title: string;
  primaryTag?: string;
  time?: number;
}

interface RecResponse {
  currentSlug: string;
  personalized: boolean;
  recommendations: RecCard[];
  reason?: string;
}

function init(): void {
  const wrapper = document.querySelector<HTMLElement>('[data-recommend-slug]');
  if (!wrapper) return;
  const target = wrapper.querySelector<HTMLElement>('[data-recommend-target]');
  const template = wrapper.querySelector<HTMLTemplateElement>('[data-recommend-template]');
  const slug = wrapper.dataset.recommendSlug;
  if (!target || !template || !slug) return;

  const ac = new AbortController();
  window.addEventListener('pagehide', () => ac.abort(), { once: true });

  fetch(`/api/recommendations?slug=${encodeURIComponent(slug)}&limit=3`, {
    credentials: 'include',
    signal: ac.signal
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((data: RecResponse) => {
      if (!data.recommendations || data.recommendations.length === 0) return; // keep static fallback
      const frag = document.createDocumentFragment();
      for (const rec of data.recommendations) {
        const node = template.content.firstElementChild?.cloneNode(true) as HTMLAnchorElement | null;
        if (!node) continue;
        node.setAttribute('href', `/tutorials/${rec.slug}`);
        const titleEl = node.querySelector('[data-recommend-title]');
        if (titleEl) titleEl.textContent = rec.title;
        const metaEl = node.querySelector('[data-recommend-meta]');
        if (metaEl) {
          if (rec.time) {
            // Build the time meta safely: <span class="next-steps-time-icon">⏱</span> N min.
            metaEl.textContent = '';
            const icon = document.createElement('span');
            icon.className = 'next-steps-time-icon';
            icon.textContent = '⏱'; // ⏱
            metaEl.appendChild(icon);
            metaEl.appendChild(document.createTextNode(` ${rec.time} min.`));
          } else {
            metaEl.remove();
          }
        }
        frag.appendChild(node);
      }
      target.replaceChildren(frag);
    })
    .catch(() => { /* silent: server-rendered fallback stays */ });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
