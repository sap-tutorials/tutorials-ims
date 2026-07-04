export function applyVerbOrder(root: HTMLElement | null, order: string[]): void {
  if (!root || !order || order.length === 0) return;
  const list = root.querySelector('ul, ol');
  if (!list) return;
  const byVerb = new Map<string, Element>();
  for (const li of list.children) {
    const v = (li as HTMLElement).dataset?.verb;
    if (v) byVerb.set(v, li);
  }
  const seen = new Set<string>();
  const frag = document.createDocumentFragment();
  for (const v of order) {
    const el = byVerb.get(v);
    if (el) { frag.appendChild(el); seen.add(v); }
  }
  for (const [v, el] of byVerb) { if (!seen.has(v)) frag.appendChild(el); }
  list.appendChild(frag);
}
