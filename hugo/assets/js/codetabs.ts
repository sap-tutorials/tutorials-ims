// U8: cross-block selection sync for codetabs.
// Pick "Java" once and every <ui5-tabcontainer data-codetabs> on the page
// (and on every page you visit afterwards) remembers — provided the block
// has a tab with that name. Backed by sync-groups.ts under key "codetabs".
// Legacy localStorage["codetabs-preference"] is honoured via sync-groups'
// migration read-fallback for one release.

import { getChoice, setChoice, onChange } from './sync-groups';

const CHANGE_EVENT = "codetabs:change";

let applying = false;

function getPreference(): string | null {
  return getChoice('codetabs');
}

function setPreference(name: string) {
  setChoice('codetabs', name);
}

type Ui5Tab = HTMLElement & { getDomRefInStrip?: () => HTMLElement | null };

function selectTabByName(container: Element, name: string): boolean {
  const tabs = Array.from(container.querySelectorAll<Ui5Tab>("ui5-tab[data-codetabs-name]"));
  const target = tabs.find((t) => t.dataset.codetabsName === name);
  if (!target) return false;
  if (target.hasAttribute("selected")) return true;
  // ui5-tabcontainer manages selection via clicks on its internal strip element;
  // mutating the `selected` attribute after upgrade does NOT repaint the panel.
  // We click the strip ref instead and use `applying` to swallow the re-fired event.
  const stripRef = target.getDomRefInStrip?.();
  if (!stripRef) return false;
  applying = true;
  stripRef.click();
  queueMicrotask(() => {
    applying = false;
  });
  return true;
}

function applyPreferenceToAll() {
  const pref = getPreference();
  if (!pref) return;
  document.querySelectorAll("ui5-tabcontainer[data-codetabs]").forEach((c) => selectTabByName(c, pref));
}

function wireContainer(container: Element) {
  container.addEventListener("tab-select", (event: Event) => {
    if (applying) return;
    const detail = (event as CustomEvent).detail as { tab?: HTMLElement } | undefined;
    const name = detail?.tab?.dataset?.codetabsName;
    if (!name) return;
    setPreference(name);
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { name, source: container } }));
  });
}

async function init() {
  const containers = document.querySelectorAll("ui5-tabcontainer[data-codetabs]");
  if (containers.length === 0) return;
  // Web components upgrade asynchronously — ui5-tab's getDomRefInStrip is only
  // available after the parent ui5-tabcontainer has rendered its strip. Wait
  // for both elements to be defined, then yield once for the first render.
  await Promise.all([
    customElements.whenDefined("ui5-tabcontainer"),
    customElements.whenDefined("ui5-tab"),
  ]);
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  containers.forEach(wireContainer);
  applyPreferenceToAll();

  document.addEventListener(CHANGE_EVENT, (event: Event) => {
    const detail = (event as CustomEvent).detail as { name?: string; source?: Element };
    if (!detail?.name) return;
    document.querySelectorAll("ui5-tabcontainer[data-codetabs]").forEach((c) => {
      if (c === detail.source) return;
      selectTabByName(c, detail.name);
    });
  });

  // Cross-tab sync via sync-groups onChange.
  onChange('codetabs', (next) => {
    document.querySelectorAll("ui5-tabcontainer[data-codetabs]").forEach((c) => selectTabByName(c, next));
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
