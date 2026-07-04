type Overrides = Record<string, { reorder: string[]; hidden: string[] }>;

function detectCurrentVerb(): string | null {
  const el = document.querySelector<HTMLElement>('[data-page-kind]')
    ?? document.documentElement;
  const kind = (el as HTMLElement).dataset?.pageKind || '';
  const m = /^verb-(.+)$/.exec(kind);
  return m ? m[1] : null;
}

export function applyShelfRerank(overrides: Overrides | undefined, currentVerb?: string): void {
  if (!overrides) return;
  const verb = currentVerb ?? detectCurrentVerb();
  if (!verb) return;
  const ov = overrides[verb];
  if (!ov) return;

  const sections = document.querySelectorAll<HTMLElement>(
    `[data-personalize="shelf-rerank"][data-verb="${verb}"]`
  );
  for (const section of sections) {
    const list = section.querySelector('ul, ol');
    if (!list) continue;

    for (const id of ov.hidden || []) {
      const el = list.querySelector<HTMLElement>(`[data-shelf-entry-id="${id}"]`);
      if (el) el.hidden = true;
    }

    if (ov.reorder && ov.reorder.length > 0) {
      const byId = new Map<string, Element>();
      for (const li of Array.from(list.children)) {
        const id = (li as HTMLElement).dataset?.shelfEntryId;
        if (id) byId.set(id, li);
      }
      const seen = new Set<string>();
      const frag = document.createDocumentFragment();
      for (const id of ov.reorder) {
        const el = byId.get(id);
        if (el) { frag.appendChild(el); seen.add(id); }
      }
      for (const [id, el] of byId) { if (!seen.has(id)) frag.appendChild(el); }
      list.appendChild(frag);
    }
  }
}
