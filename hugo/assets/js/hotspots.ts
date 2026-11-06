export function initHotspots(): void {
  document.querySelectorAll<HTMLElement>('.tut-hotspot-wrap').forEach(wrap => {
    const markers = Array.from(wrap.querySelectorAll<HTMLElement>('[data-hotspot-n]'));
    // Find the next sibling <ol> element
    let sibling: Element | null = wrap.nextElementSibling;
    while (sibling && sibling.tagName !== 'OL') sibling = sibling.nextElementSibling;
    const list = sibling as HTMLOListElement | null;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>('li'));

    markers.forEach(marker => {
      const n = parseInt(marker.dataset.hotspotN ?? '1', 10) - 1;
      const li = items[n];
      if (!li) return;
      marker.addEventListener('focus', () => li.classList.add('tut-hotspot--active'));
      marker.addEventListener('blur', () => li.classList.remove('tut-hotspot--active'));
      li.addEventListener('focus', () => marker.classList.add('tut-hotspot--active'));
      li.addEventListener('blur', () => marker.classList.remove('tut-hotspot--active'));
    });
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHotspots);
  } else {
    initHotspots();
  }
}
