(async function upgradePopularRail() {
  const rail = document.getElementById('popular-rail');
  if (!rail) return;

  try {
    const res = await fetch('/build/catalog', { credentials: 'omit' });
    if (!res.ok) return;
    const data = await res.json();
    const featured = Array.isArray(data && data.featured) ? data.featured : [];
    if (featured.length === 0) return;

    const items = featured.map(f => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      const slugPath = f.type === 'tutorial' ? `/tutorials/${f.slug}` : `/${f.type}s/${f.slug}/`;
      a.href = slugPath;

      const h3 = document.createElement('h3');
      h3.textContent = f.title || '';
      a.appendChild(h3);

      const p = document.createElement('p');
      const desc = (f.description || '').slice(0, 140);
      p.textContent = desc;
      a.appendChild(p);

      li.appendChild(a);
      return li;
    });

    rail.replaceChildren(...items);
    rail.dataset.source = 'featured';
  } catch (err) {
    // Silent — static fallback remains.
    if (window.console) console.debug('[popular-rail] upgrade failed:', err);
  }
})();
