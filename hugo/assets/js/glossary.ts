// U9: inline glossary tooltips. Walks tutorial body text once on load,
// wraps the first occurrence per page of each known SAP acronym in a
// <span data-glossary> trigger, and shows a single shared <ui5-popover>
// with the term, definition, and primer link on hover/focus.
//
// Why a TreeWalker instead of replaceRE in Hugo: regex over rendered HTML
// risks injecting <span> inside <code>, <a>, or attribute values. The DOM
// walker only touches text nodes and skips CODE/PRE/A ancestors cleanly.

interface GlossaryTerm {
  term: string;
  definition: string;
  link: string;
}

type GlossaryMap = Record<string, GlossaryTerm>;

const SCOPE_SELECTOR = ".tutorial-steps, .glossary-scope";
const SKIP_ANCESTORS = new Set(["CODE", "PRE", "A", "BUTTON", "TEXTAREA", "INPUT"]);
const SKIP_ATTR = "data-glossary-skip";

type Ui5Popover = HTMLElement & { opener: Element | string; open: boolean };

function loadGlossary(): GlossaryMap {
  // Hugo injects the parsed YAML as `window.__glossary` in baseof.html.
  // We use a global rather than `<script type="application/json">` because
  // Go's html/template applies contextual JS-string escaping inside <script>
  // even when the type is application/json — an inline JS literal sidesteps that.
  const data = (window as unknown as { __glossary?: { terms?: GlossaryMap } }).__glossary;
  return data?.terms ?? {};
}

function shouldSkip(node: Node): boolean {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    if (SKIP_ANCESTORS.has(el.tagName)) return true;
    if (el.hasAttribute(SKIP_ATTR)) return true;
    if (el.classList.contains("glossary-term")) return true;
    el = el.parentElement;
  }
  return false;
}

function buildPattern(keys: string[]): RegExp {
  // Sort longest-first so "OData" wins over a hypothetical "Data" entry.
  const escaped = keys
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
}

function tagFirstOccurrences(root: Element, glossary: GlossaryMap): void {
  const keys = Object.keys(glossary);
  if (keys.length === 0) return;
  const pattern = buildPattern(keys);
  const seen = new Set<string>();

  // Collect text nodes first so we can mutate without invalidating the walker.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    const matches: { start: number; end: number; key: string }[] = [];
    for (const match of text.matchAll(pattern)) {
      const key = match[1];
      const start = match.index ?? 0;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ start, end: start + key.length, key });
    }
    if (matches.length === 0) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      }
      const span = document.createElement("span");
      span.className = "glossary-term";
      span.dataset.glossary = match.key;
      span.tabIndex = 0;
      span.textContent = text.slice(match.start, match.end);
      frag.appendChild(span);
      cursor = match.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function wirePopover(glossary: GlossaryMap): void {
  const popover = document.getElementById("glossary-popover") as Ui5Popover | null;
  if (!popover) return;
  const termEl = popover.querySelector<HTMLElement>(".glossary-popover__term");
  const defEl = popover.querySelector<HTMLParagraphElement>(".glossary-popover__definition");
  const linkEl = popover.querySelector<HTMLAnchorElement>(".glossary-popover__link");
  if (!termEl || !defEl || !linkEl) return;

  let openFor: Element | null = null;
  let closeTimer: number | null = null;

  function fillPopover(key: string): boolean {
    const entry = glossary[key];
    if (!entry) return false;
    termEl!.textContent = entry.term;
    defEl!.textContent = entry.definition;
    if (entry.link) {
      linkEl!.href = entry.link;
      linkEl!.style.display = "";
    } else {
      linkEl!.removeAttribute("href");
      linkEl!.style.display = "none";
    }
    return true;
  }

  function show(target: HTMLElement) {
    const key = target.dataset.glossary;
    if (!key || !fillPopover(key)) return;
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (openFor === target && popover!.open) return;
    openFor = target;
    popover!.opener = target;
    popover!.open = true;
  }

  function scheduleHide() {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    // Brief delay so users can move the cursor from the term into the popover
    // (e.g. to click the "Learn more" link) without it snapping shut.
    closeTimer = window.setTimeout(() => {
      popover!.open = false;
      openFor = null;
      closeTimer = null;
    }, 180);
  }

  document.addEventListener("mouseover", (event) => {
    const term = (event.target as Element | null)?.closest<HTMLElement>(".glossary-term");
    if (term) show(term);
  });
  document.addEventListener("mouseout", (event) => {
    const term = (event.target as Element | null)?.closest(".glossary-term");
    if (!term) return;
    const related = event.relatedTarget as Node | null;
    if (related && (term.contains(related) || popover.contains(related))) return;
    scheduleHide();
  });
  popover.addEventListener("mouseenter", () => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
  });
  popover.addEventListener("mouseleave", scheduleHide);

  document.addEventListener("focusin", (event) => {
    const term = (event.target as Element | null)?.closest<HTMLElement>(".glossary-term");
    if (term) show(term);
  });
  document.addEventListener("focusout", (event) => {
    const term = (event.target as Element | null)?.closest(".glossary-term");
    if (!term) return;
    const next = event.relatedTarget as Node | null;
    if (next && (term.contains(next) || popover.contains(next))) return;
    scheduleHide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !popover.open) return;
    popover.open = false;
    if (openFor instanceof HTMLElement) openFor.focus();
    openFor = null;
  });
}

function init() {
  const glossary = loadGlossary();
  if (Object.keys(glossary).length === 0) return;
  document.querySelectorAll(SCOPE_SELECTOR).forEach((root) => {
    tagFirstOccurrences(root, glossary);
  });
  wirePopover(glossary);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
