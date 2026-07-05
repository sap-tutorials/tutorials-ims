// hugo-apps/src/homepage-personalizer/teaser-rerank.ts
// (#763) Reorders the Row-5 tutorial-teaser cards by the server-supplied slug array.
// Existing DOM cards are moved; missing slugs are fetched via the callback and
// appended. Cards not mentioned in `order` are preserved after the reordered set.

export interface FetchedCard { slug: string; html: string; }

export async function applyTeaserRerank(
  root: HTMLElement | null,
  order: string[],
  fetchMissing: (slugs: string[]) => Promise<FetchedCard[]>
): Promise<void> {
  if (!root || !order || order.length === 0) return;
  const list = root.querySelector('.cards') || root;
  const existing = new Map<string, Element>();
  for (const el of Array.from(list.children)) {
    const s = (el as HTMLElement).dataset?.slug;
    if (s) existing.set(s, el);
  }
  const missing = order.filter((s) => !existing.has(s));
  let fetched: FetchedCard[] = [];
  if (missing.length > 0) {
    try { fetched = await fetchMissing(missing); } catch { fetched = []; }
  }
  // Parse each server-supplied HTML fragment via <template> (inert per spec —
  // scripts won't execute, resources won't load). All fields in the HTML are
  // HTML-escaped server-side by the tutorialCards handler, so this is safe.
  const parsed = new Map<string, Element>();
  for (const f of fetched) {
    const tpl = document.createElement('template');
    tpl.innerHTML = f.html.trim();
    const el = tpl.content.firstElementChild;
    if (el) parsed.set(f.slug, el);
  }
  const frag = document.createDocumentFragment();
  for (const slug of order) {
    const el = existing.get(slug) || parsed.get(slug);
    if (el) frag.appendChild(el);
  }
  for (const [slug, el] of existing) {
    if (!order.includes(slug)) frag.appendChild(el);
  }
  list.appendChild(frag);
}
