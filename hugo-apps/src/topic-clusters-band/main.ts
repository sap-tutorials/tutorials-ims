import { mergeVolatile, type ClusterItem } from './hydrate';

const TOTAL = 8;

function readCardItems(ul: HTMLElement): ClusterItem[] {
  return Array.from(ul.querySelectorAll<HTMLElement>('li[data-kind]')).map(li => ({
    kind: li.getAttribute('data-kind') || '',
    slug: li.getAttribute('data-slug') || '',
    title: li.querySelector('a')?.textContent?.trim() || '',
    href: li.querySelector('a')?.getAttribute('href') || '',
  }));
}

function renderItems(ul: HTMLElement, items: ClusterItem[]): void {
  ul.replaceChildren(...items.map(i => {
    const li = document.createElement('li');
    li.setAttribute('data-kind', i.kind);
    li.setAttribute('data-slug', i.slug);
    const a = document.createElement('a');
    a.href = i.href;
    a.textContent = i.title || i.slug;  // textContent never parses HTML
    const span = document.createElement('span');
    span.className = `hp-tc-badge hp-tc-badge--${i.kind}`;
    span.textContent = i.kind;
    li.append(a, span);
    return li;
  }));
}

async function hydrate(root: HTMLElement): Promise<void> {
  const etag = root.getAttribute('data-etag') || '';
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch('/homepage/topicClusterVolatile()', { headers });
    if (res.status === 304 || !res.ok) return;      // fail-open: keep SSR
    const body = await res.json();
    const clusters = body.clusters ?? body.value?.[0]?.clusters ?? [];
    const byFp = new Map<string, ClusterItem[]>(clusters.map((c: any) => [c.communityFingerprint, c.items || []]));
    root.querySelectorAll<HTMLElement>('.hp-topic-clusters__cluster[data-fp]').forEach(card => {
      const fp = card.getAttribute('data-fp') || '';
      const vol = byFp.get(fp);
      if (!vol || !vol.length) return;
      const ul = card.querySelector<HTMLElement>('.hp-topic-clusters__links');
      if (!ul) return;
      renderItems(ul, mergeVolatile(readCardItems(ul), vol, TOTAL));
    });
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[topic-clusters-band] hydration failed', err);
  }
}

document.querySelectorAll<HTMLElement>('[data-app="topic-clusters-band"]').forEach(hydrate);
