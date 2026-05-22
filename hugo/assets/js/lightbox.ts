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

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function viewport(): HTMLElement | null {
  return document.querySelector("[data-lightbox-viewport]");
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function clampPan() {
  // Keep at least 25% of the image inside the viewport.
  const vp = viewport();
  const cur = currentImg();
  if (!vp || !cur) return;
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  const iw = cur.clientWidth * state.scale;
  const ih = cur.clientHeight * state.scale;
  const maxX = Math.max(0, (iw - vw) / 2 + vw * 0.75);
  const maxY = Math.max(0, (ih - vh) / 2 + vh * 0.75);
  state.tx = Math.min(maxX, Math.max(-maxX, state.tx));
  state.ty = Math.min(maxY, Math.max(-maxY, state.ty));
}

/** Adjust scale around a screen-space origin so the point under (originX, originY)
 * stays under the same point post-zoom. originX/originY are viewport-relative. */
function setZoom(newScale: number, originX: number, originY: number) {
  const vp = viewport();
  const cur = currentImg();
  if (!vp || !cur) return;
  const next = clampScale(newScale);
  if (next === state.scale) return;
  const rect = vp.getBoundingClientRect();
  // origin in viewport coords
  const ox = originX - rect.left - rect.width / 2;
  const oy = originY - rect.top - rect.height / 2;
  // Adjust translation so the world-space point under (ox, oy) is preserved.
  const ratio = next / state.scale;
  state.tx = ox - (ox - state.tx) * ratio;
  state.ty = oy - (oy - state.ty) * ratio;
  state.scale = next;
  if (state.scale === 1) {
    state.tx = 0;
    state.ty = 0;
  }
  clampPan();
  applyTransform(cur);
  updateZoomLabel();
}

function zoomBy(delta: number, originX: number, originY: number) {
  setZoom(state.scale + delta, originX, originY);
}

function zoomCenter(delta: number) {
  const vp = viewport();
  if (!vp) return;
  const r = vp.getBoundingClientRect();
  zoomBy(delta, r.left + r.width / 2, r.top + r.height / 2);
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

  const vp = viewport();
  if (vp) {
    vp.addEventListener("wheel", (e) => {
      if (!state.isOpen) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.003;
      zoomBy(delta, e.clientX, e.clientY);
    }, { passive: false });
  }

  document.querySelector(".lightbox-zoom-in")
    ?.addEventListener("click", () => zoomCenter(0.5));
  document.querySelector(".lightbox-zoom-out")
    ?.addEventListener("click", () => zoomCenter(-0.5));
  document.querySelector(".lightbox-reset")
    ?.addEventListener("click", () => {
      state.scale = 1; state.tx = 0; state.ty = 0;
      const cur = currentImg();
      if (cur) applyTransform(cur);
      updateZoomLabel();
    });

  // Keyboard while dialog is open. Esc is owned by ui5-dialog; we stay clear of it.
  // ui5-dialog traps focus inside its shadow DOM, so document-level keydown won't
  // fire for keys pressed while a focused element is inside the dialog. Attach
  // the same handler to the dialog itself as well so +/-/0 work regardless of
  // which element has focus.
  function onZoomKey(e: KeyboardEvent) {
    if (!state.isOpen) return;
    if (e.key === "+" || e.key === "=") { zoomCenter(0.5); e.preventDefault(); }
    else if (e.key === "-") { zoomCenter(-0.5); e.preventDefault(); }
    else if (e.key === "0") {
      state.scale = 1; state.tx = 0; state.ty = 0;
      const cur = currentImg();
      if (cur) applyTransform(cur);
      updateZoomLabel();
      e.preventDefault();
    }
  }
  document.addEventListener("keydown", onZoomKey);
  dlg.addEventListener("keydown", onZoomKey);

  // Single-pointer pan. Two-pointer pinch lands in Task 6.
  let panActive = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTx = 0;
  let panStartTy = 0;

  if (vp) {
    vp.addEventListener("pointerdown", (e) => {
      if (state.scale <= 1) return;
      panActive = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartTx = state.tx;
      panStartTy = state.ty;
      vp.classList.add("is-panning");
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener("pointermove", (e) => {
      if (!panActive) return;
      state.tx = panStartTx + (e.clientX - panStartX);
      state.ty = panStartTy + (e.clientY - panStartY);
      clampPan();
      const cur = currentImg();
      if (cur) applyTransform(cur);
    });
    const endPan = (e: PointerEvent) => {
      if (!panActive) return;
      panActive = false;
      vp.classList.remove("is-panning");
      try { vp.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    vp.addEventListener("pointerup", endPan);
    vp.addEventListener("pointercancel", endPan);
  }

  // Browser back closes the dialog. Gate on state.isOpen rather than the dialog's
  // `open` attribute — ui5-dialog reflects open as a property, not a DOM attribute,
  // so hasAttribute("open") returns false even while the dialog is showing.
  window.addEventListener("popstate", () => {
    if (state.isOpen) dlg.close();
  });
}

initLightbox();
