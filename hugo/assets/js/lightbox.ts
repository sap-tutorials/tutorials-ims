// hugo/assets/js/lightbox.ts
//
// U15: ui5-dialog-based image lightbox. Replaces the native <dialog> in
// tutorial.ts. Self-bootstraps via initLightbox() at module bottom and is
// imported from ui5-bootstrap.ts so it runs on every markdown page.
//
// State is module-scoped. `imgs` is recomputed on every open() so dynamically
// injected images (e.g., Vue islands) participate.

type LightboxDialog = HTMLElement & { show: () => void; close: () => void };

type LightboxState = {
  imgs: HTMLImageElement[];
  index: number;
  scale: number;
  tx: number;
  ty: number;
  pushedHash: boolean;
  animating: boolean;
  isOpen: boolean;
};

const state: LightboxState = {
  imgs: [],
  index: 0,
  scale: 1,
  tx: 0,
  ty: 0,
  pushedHash: false,
  animating: false,
  isOpen: false,
};

function dialog(): LightboxDialog | null {
  return document.getElementById("image-lightbox") as LightboxDialog | null;
}

function currentImg(): HTMLImageElement | null {
  return document.querySelector(".lightbox-img--current");
}

function incomingImg(): HTMLImageElement | null {
  return document.querySelector(".lightbox-img--incoming");
}

function titleEl(): HTMLElement | null {
  return document.querySelector(".lightbox-title");
}

function collectZoomable(): HTMLImageElement[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('img[data-zoomable="true"]'),
  );
}

function setTitle(text: string) {
  const el = titleEl();
  if (el) el.textContent = text;
}

function open(triggerImg: HTMLImageElement) {
  const dlg = dialog();
  const cur = currentImg();
  if (!dlg || !cur) return;

  state.imgs = collectZoomable();
  state.index = Math.max(0, state.imgs.indexOf(triggerImg));
  state.scale = 1;
  state.tx = 0;
  state.ty = 0;
  state.animating = false;

  cur.src = triggerImg.currentSrc || triggerImg.src;
  cur.alt = triggerImg.alt || "";
  applyTransform(cur);
  setTitle(triggerImg.alt && triggerImg.alt !== "image" ? triggerImg.alt : "");

  togglePrevNext();

  // History deep-link: pushState only when not entering via URL hash.
  // (initFromHash() sets pushedHash = false to suppress this.)
  const hashTarget = `#img-${state.index + 1}`;
  if (location.hash !== hashTarget) {
    history.pushState({ lightbox: true }, "", hashTarget);
    state.pushedHash = true;
  } else {
    // We're entering via the URL hash (deep-link path) OR re-opening at the
    // same index after a previous close that ran history.back(). Either way
    // the hash already matches, so close() must use replaceState.
    state.pushedHash = false;
  }

  // Mobile stretch: matchMedia snapshot on open; we don't re-evaluate on resize.
  if (matchMedia("(max-width: 640px)").matches) {
    dlg.setAttribute("stretch", "");
  } else {
    dlg.removeAttribute("stretch");
  }

  customElements.whenDefined("ui5-dialog").then(() => {
    state.isOpen = true;
    dlg.show();
  });
}

function close() {
  const cur = currentImg();
  state.scale = 1;
  state.tx = 0;
  state.ty = 0;
  state.animating = false;
  state.isOpen = false;
  if (cur) applyTransform(cur);
  updateZoomLabel();

  if (state.pushedHash) {
    state.pushedHash = false;
    history.back(); // popstate handler ignores when dialog is already closed
  } else if (location.hash.startsWith("#img-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function togglePrevNext() {
  const prev = document.querySelector<HTMLElement>(".lightbox-prev");
  const next = document.querySelector<HTMLElement>(".lightbox-next");
  if (!prev || !next) return;
  const single = state.imgs.length <= 1;
  prev.toggleAttribute("hidden", single);
  next.toggleAttribute("hidden", single);
}

function applyTransform(img: HTMLImageElement) {
  img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}

function updateZoomLabel() {
  const lbl = document.querySelector<HTMLElement>(".lightbox-zoom-level");
  if (lbl) lbl.textContent = `${Math.round(state.scale * 100)}%`;
}

export function initLightbox() {
  const dlg = dialog();
  if (!dlg) return;

  // Click delegation on the document — catches images injected post-init.
  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const img = target?.closest<HTMLImageElement>('img[data-zoomable="true"]');
    if (img) open(img);
  });

  // Close button → dialog.close(); the close-event handler does teardown.
  document
    .querySelector(".lightbox-close")
    ?.addEventListener("click", () => dlg.close());

  // ui5-dialog dispatches native `close` event on Esc and on .close().
  dlg.addEventListener("close", close);

  // Browser back closes the dialog. Gate on state.isOpen rather than the dialog's
  // `open` attribute — ui5-dialog reflects open as a property, not a DOM attribute,
  // so hasAttribute("open") returns false even while the dialog is showing.
  window.addEventListener("popstate", () => {
    if (state.isOpen) dlg.close();
  });
}

initLightbox();
