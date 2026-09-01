// hugo-apps/src/topics-tree/main.ts
//
// Progressive enhancement over the server-rendered <details>/<ul> tree that
// renderTopicListBody() (srv/lib/topic-list-page.js) emits under
// <article id="topics-tree-root">.
// Adds: type-ahead filter and hash deep-link (#topic=<slug>).
// Inert until JS loads; the server markup is fully functional without it.

function boot(): void {
  const root = document.getElementById('topics-tree-root');
  const input = document.getElementById('topics-filter-input') as HTMLInputElement | null;
  if (!root || !input) return;

  const allDetails = Array.from(root.querySelectorAll<HTMLDetailsElement>('details'));
  // Capture the initial open state so we can restore on query clear.
  const initialOpen = new Map(allDetails.map(d => [d, d.open]));

  function applyFilter(q: string): void {
    if (!q) {
      // Restore all li visibility and original details open states.
      root.querySelectorAll<HTMLLIElement>('li').forEach(li => { li.style.display = ''; });
      allDetails.forEach(d => { d.open = initialOpen.get(d) ?? false; });
      return;
    }

    // Hide every li and close every details; then show matching leaves
    // and walk up to reveal their ancestors.
    root.querySelectorAll<HTMLLIElement>('li').forEach(li => { li.style.display = 'none'; });
    allDetails.forEach(d => { d.open = false; });

    root.querySelectorAll<HTMLLIElement>('li').forEach(li => {
      // Only process leaf nodes (those without a direct nested <details>).
      if (li.querySelector(':scope > details')) return;
      const text = (li.textContent ?? '').toLowerCase();
      if (!text.includes(q)) return;
      // Match: reveal this leaf and walk up to show all ancestor li + open ancestor details.
      li.style.display = '';
      let el: Element | null = li.parentElement;
      while (el && el !== root) {
        if (el.tagName === 'LI') (el as HTMLElement).style.display = '';
        if (el.tagName === 'DETAILS') (el as HTMLDetailsElement).open = true;
        el = el.parentElement;
      }
    });
  }

  input.addEventListener('input', () => {
    applyFilter(input.value.trim().toLowerCase());
  });

  // Deep-link: #topic=<slug> opens the matching node's ancestor details + scrolls into view.
  const m = location.hash.match(/topic=([a-zA-Z0-9-]+)/);
  if (m) {
    const link = root.querySelector<HTMLElement>(`a[href="/topics/${m[1]}/"]`);
    if (link) {
      let d: HTMLDetailsElement | null = link.closest('details');
      while (d) {
        d.open = true;
        d = d.parentElement?.closest<HTMLDetailsElement>('details') ?? null;
      }
      link.scrollIntoView({ block: 'center' });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
