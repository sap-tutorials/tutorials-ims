// hugo/assets/js/lightbox.ts
//
// U15: ui5-dialog-based image lightbox. Replaces the native <dialog> in
// tutorial.ts. Self-bootstraps via initLightbox() at module bottom and is
// imported from ui5-bootstrap.ts so it runs on every markdown page.
//
// State is module-scoped. `imgs` is recomputed on every open() so dynamically
// injected images (e.g., Vue islands) participate.
//
// #1785 polish: keyboard-open (Enter/Space on a focused zoomable image),
// double-click / double-tap zoom toggle, horizontal swipe navigation at 1x,
// an image counter + figcaption title, a thumbnail filmstrip, and a loading
// spinner. Pure decision helpers are exported via `__test__` for unit tests.

// UI5 v2.x ui5-dialog: open is a property (not a DOM attribute, not a method).
// Setting `dlg.open = true` shows the dialog and dispatches `open`/`opened` events.
// Setting `dlg.open = false` closes and dispatches `close` event. The legacy
// `.show()` / `.close()` methods were removed.
type LightboxDialog = HTMLElement & { open: boolean };

type LightboxState = {
  imgs: HTMLImageElement[];
  index: number;
  scale: number;
  tx: number;
  ty: number;
  pushedHash: boolean;
  animating: boolean;
  isOpen: boolean;
  triggerEl: HTMLElement | null;
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
  triggerEl: null,
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

function counterEl(): HTMLElement | null {
  return document.querySelector(".lightbox-counter");
}

function spinnerEl(): HTMLElement | null {
  return document.querySelector(".lightbox-spinner");
}

function thumbsEl(): HTMLElement | null {
  return document.querySelector(".lightbox-thumbs");
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

/** The lightbox title/caption for an image: the figure's caption when present,
 * else the alt text (ignoring the "image" placeholder), else empty. */
function deriveCaption(img: HTMLImageElement): string {
  const cap = img
    .closest("figure")
    ?.querySelector(".tutorial-figcaption")
    ?.textContent?.trim();
  if (cap) return cap;
  const alt = (img.alt || "").trim();
  return alt && alt !== "image" ? alt : "";
}

/** 1-based "index / total" label for the counter. */
function formatCounter(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

function updateCounter() {
  const el = counterEl();
  if (!el) return;
  const total = state.imgs.length;
  if (total <= 1) {
    el.setAttribute("hidden", "");
    el.textContent = "";
    return;
  }
  el.removeAttribute("hidden");
  el.textContent = formatCounter(state.index, total);
}

function showSpinner(show: boolean) {
  const s = spinnerEl();
  if (!s) return;
  if (show) s.removeAttribute("hidden");
  else s.setAttribute("hidden", "");
}

/** Show the spinner until `img` finishes loading. Handles the already-cached
 * case (complete + decoded) so it never flashes for instant loads. */
function bindSpinner(img: HTMLImageElement) {
  showSpinner(true);
  const hide = () => showSpinner(false);
  img.addEventListener("load", hide, { once: true });
  img.addEventListener("error", hide, { once: true });
  if (img.complete && img.naturalWidth > 0) hide();
}

/** Build the thumbnail filmstrip. Hidden for single-image pages. Each thumb is
 * a real <button> (keyboard-focusable); clicking one calls onSelect(index). */
function buildThumbs(
  container: HTMLElement,
  imgs: HTMLImageElement[],
  activeIndex: number,
  onSelect: (index: number) => void,
) {
  container.replaceChildren();
  if (imgs.length <= 1) {
    container.setAttribute("hidden", "");
    return;
  }
  container.removeAttribute("hidden");
  imgs.forEach((img, i) => {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "lightbox-thumb" + (i === activeIndex ? " is-active" : "");
    t.setAttribute("aria-label", `View image ${i + 1}`);
    if (i === activeIndex) t.setAttribute("aria-current", "true");
    const im = document.createElement("img");
    im.src = img.currentSrc || img.src;
    im.alt = "";
    im.loading = "lazy";
    t.appendChild(im);
    t.addEventListener("click", () => onSelect(i));
    container.appendChild(t);
  });
}

function highlightThumb(index: number) {
  const c = thumbsEl();
  if (!c) return;
  const thumbs = c.querySelectorAll<HTMLElement>(".lightbox-thumb");
  thumbs.forEach((t, i) => {
    const active = i === index;
    t.classList.toggle("is-active", active);
    if (active) {
      t.setAttribute("aria-current", "true");
      t.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
    } else {
      t.removeAttribute("aria-current");
    }
  });
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
  state.triggerEl = triggerImg;
  // Set synchronously so wheel/pointer/dblclick handlers (which gate on isOpen)
  // are live as soon as open() returns; dlg.open is flipped once the custom
  // element is defined below.
  state.isOpen = true;

  cur.src = triggerImg.currentSrc || triggerImg.src;
  cur.alt = triggerImg.alt || "";
  applyTransform(cur);
  bindSpinner(cur);
  setTitle(deriveCaption(triggerImg));
  updateCounter();

  togglePrevNext();
  const thumbs = thumbsEl();
  if (thumbs) buildThumbs(thumbs, state.imgs, state.index, (i) => slideTo(i));

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

  preloadNeighbors();
  customElements.whenDefined("ui5-dialog").then(() => {
    dlg.open = true;
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

  // Return focus to the image that opened the lightbox (keyboard users land
  // back where they were). ui5-dialog also restores focus, but the trigger is
  // now focusable so this is explicit and covers mouse-opened cases too.
  const trigger = state.triggerEl;
  state.triggerEl = null;
  if (trigger && typeof trigger.focus === "function") {
    try { trigger.focus(); } catch { /* element gone */ }
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

const SLIDE_DURATION_MS = 300;

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rail(): HTMLElement | null {
  return document.querySelector(".lightbox-rail");
}

function preloadNeighbors() {
  const prev = state.imgs[state.index - 1];
  const next = state.imgs[state.index + 1];
  if (prev) new Image().src = prev.currentSrc || prev.src;
  if (next) new Image().src = next.currentSrc || next.src;
}

/** Jump to an arbitrary index with no animation (multi-step thumb jumps,
 * reduced-motion, and adjacent moves when animation is off). */
function instantSwapTo(targetIdx: number) {
  const cur = currentImg();
  const target = state.imgs[targetIdx];
  if (!cur || !target) return;
  cur.src = target.currentSrc || target.src;
  cur.alt = target.alt || "";
  state.index = targetIdx;
  state.scale = 1;
  state.tx = 0;
  state.ty = 0;
  applyTransform(cur);
  bindSpinner(cur);
  setTitle(deriveCaption(target));
  togglePrevNext();
  updateZoomLabel();
  updateCounter();
  highlightThumb(state.index);
  history.replaceState({ lightbox: true }, "", `#img-${state.index + 1}`);
  preloadNeighbors();
}

function goto(direction: -1 | 1) {
  if (state.animating) return;
  const targetIdx = state.index + direction;
  if (targetIdx < 0 || targetIdx >= state.imgs.length) return;

  if (reducedMotion()) {
    instantSwapTo(targetIdx);
    return;
  }

  const cur = currentImg();
  const inc = incomingImg();
  const r = rail();
  const target = state.imgs[targetIdx];
  if (!cur || !inc || !r || !target) return;

  state.animating = true;
  // Reset zoom/pan immediately on the outgoing image so the slide doesn't fight scale.
  state.scale = 1; state.tx = 0; state.ty = 0;
  applyTransform(cur);

  const sign = direction; // 1 = next (incoming from right), -1 = prev (from left)
  inc.src = target.currentSrc || target.src;
  inc.alt = target.alt || "";
  inc.hidden = false;
  inc.style.transform = `translateX(${sign * 100}%)`;
  bindSpinner(inc);
  // Force layout so the next class addition triggers a transition.
  void inc.offsetWidth;

  r.classList.add("is-sliding");
  inc.style.transform = "translateX(0)";
  cur.style.transform = `translateX(${-sign * 100}%) scale(1)`;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    r.classList.remove("is-sliding");
    // Swap classes: incoming becomes current.
    cur.classList.remove("lightbox-img--current");
    cur.classList.add("lightbox-img--incoming");
    cur.hidden = true;
    inc.classList.remove("lightbox-img--incoming");
    inc.classList.add("lightbox-img--current");
    state.index = targetIdx;
    state.animating = false;
    applyTransform(inc);
    setTitle(deriveCaption(target));
    togglePrevNext();
    updateZoomLabel();
    updateCounter();
    highlightThumb(state.index);
    history.replaceState({ lightbox: true }, "", `#img-${state.index + 1}`);
    preloadNeighbors();
  };

  inc.addEventListener("transitionend", finish, { once: true });
  setTimeout(finish, SLIDE_DURATION_MS + 50); // fallback if transitionend is missed
}

/** Navigate to any index: animate adjacent moves, jump instantly otherwise. */
function slideTo(targetIdx: number) {
  if (state.animating) return;
  if (targetIdx < 0 || targetIdx >= state.imgs.length || targetIdx === state.index) return;
  const delta = targetIdx - state.index;
  if (Math.abs(delta) === 1 && !reducedMotion()) {
    goto(delta as -1 | 1);
  } else {
    instantSwapTo(targetIdx);
  }
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

/** 1x <-> 2x toggle target for double-click / double-tap. */
function nextZoomToggleScale(scale: number): number {
  return scale === 1 ? 2 : 1;
}

/** Decide swipe navigation from a single-pointer gesture. Only navigates at
 * scale 1 (zoomed-in single-pointer drags pan instead), when the horizontal
 * delta exceeds `threshold` and dominates the vertical delta. Returns +1 (next,
 * swiped left), -1 (prev, swiped right), or 0 (no navigation). */
function resolveSwipe(dx: number, dy: number, scale: number, threshold: number): -1 | 0 | 1 {
  if (scale !== 1) return 0;
  if (Math.abs(dx) <= threshold) return 0;
  if (Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

function resetZoom() {
  state.scale = 1;
  state.tx = 0;
  state.ty = 0;
  const cur = currentImg();
  if (cur) applyTransform(cur);
  updateZoomLabel();
}

/** Toggle zoom around a screen-space origin (double-click / double-tap). */
function toggleZoom(originX: number, originY: number) {
  if (nextZoomToggleScale(state.scale) === 1) resetZoom();
  else setZoom(2, originX, originY);
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

  // Keyboard open: Enter/Space on a focused zoomable image. Images carry
  // tabindex/role=button (see render-image.html), so they're reachable by Tab.
  document.addEventListener("keydown", (e) => {
    if (state.isOpen) return;
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const target = e.target as Element | null;
    const img = target?.closest?.<HTMLImageElement>('img[data-zoomable="true"]');
    if (img) {
      e.preventDefault();
      open(img);
    }
  });

  // Close button → set open=false; the close-event handler does teardown.
  document
    .querySelector(".lightbox-close")
    ?.addEventListener("click", () => { dlg.open = false; });

  // ui5-dialog dispatches native `close` event when open=false. Esc-driven
  // dismissal flows through the same path.
  dlg.addEventListener("close", close);

  const vp = viewport();
  if (vp) {
    vp.addEventListener("wheel", (e) => {
      if (!state.isOpen) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.003;
      zoomBy(delta, e.clientX, e.clientY);
    }, { passive: false });

    // Double-click toggles 1x <-> 2x centered on the cursor.
    vp.addEventListener("dblclick", (e) => {
      if (!state.isOpen) return;
      e.preventDefault();
      toggleZoom(e.clientX, e.clientY);
    });
  }

  document.querySelector(".lightbox-zoom-in")
    ?.addEventListener("click", () => zoomCenter(0.5));
  document.querySelector(".lightbox-zoom-out")
    ?.addEventListener("click", () => zoomCenter(-0.5));
  document.querySelector(".lightbox-reset")
    ?.addEventListener("click", () => resetZoom());

  document.querySelector(".lightbox-prev")
    ?.addEventListener("click", () => goto(-1));
  document.querySelector(".lightbox-next")
    ?.addEventListener("click", () => goto(1));

  document.querySelector(".lightbox-download")
    ?.addEventListener("click", () => {
      const cur = currentImg();
      if (!cur) return;
      const src = cur.currentSrc || cur.src;
      // Filename derivation: prefer slugified alt, fall back to URL pathname,
      // fall back to "image". The /img-cdn/ proxy URL has the original filename
      // in the `u` query param, so try that next.
      let name = "image";
      if (cur.alt && cur.alt !== "image") {
        name = cur.alt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      } else {
        try {
          const url = new URL(src, location.href);
          const u = url.searchParams.get("u");
          if (u) {
            const inner = new URL(u);
            const last = inner.pathname.split("/").pop();
            if (last) name = last.replace(/\.[a-z]+$/i, "");
          } else {
            const last = url.pathname.split("/").pop();
            if (last) name = last.replace(/\.[a-z]+$/i, "");
          }
        } catch { /* keep "image" */ }
      }
      // Append extension if missing.
      if (!/\.[a-z]+$/i.test(name)) {
        const m = src.match(/\.(png|jpe?g|gif|webp|svg)(?:\?|$)/i);
        name += m ? `.${m[1].toLowerCase()}` : ".png";
      }
      const a = document.createElement("a");
      a.href = src;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
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
    else if (e.key === "0") { resetZoom(); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { goto(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goto(1); e.preventDefault(); }
  }
  document.addEventListener("keydown", onZoomKey);
  dlg.addEventListener("keydown", onZoomKey);

  // Pointer Events: single pointer = pan (zoomed) / swipe-or-tap (at 1x); two
  // pointers = pinch. We track active pointers in a Map and route on size.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchPrevDist = 0;
  let panStartTx = 0;
  let panStartTy = 0;
  let panStartX = 0;
  let panStartY = 0;
  // Single-pointer gesture tracking for swipe + double-tap.
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let wasSinglePointer = false;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const SWIPE_THRESHOLD = 50; // px horizontal to trigger prev/next at 1x
  const TAP_MOVE = 10;        // px — max movement to still count as a tap
  const TAP_MAX_MS = 300;     // ms — max duration to count as a tap
  const DBLTAP_MS = 300;      // ms — window between taps for a double-tap
  const DBLTAP_DIST = 40;     // px — max distance between the two taps

  function distance(a: {x: number; y: number}, b: {x: number; y: number}): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function midpoint(a: {x: number; y: number}, b: {x: number; y: number}) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  if (vp) {
    vp.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      vp.setPointerCapture(e.pointerId);
      if (pointers.size === 1) {
        wasSinglePointer = true;
        downX = e.clientX;
        downY = e.clientY;
        downTime = e.timeStamp;
        if (state.scale > 1) {
          panStartX = e.clientX;
          panStartY = e.clientY;
          panStartTx = state.tx;
          panStartTy = state.ty;
          vp.classList.add("is-panning");
        }
      } else if (pointers.size === 2) {
        wasSinglePointer = false;
        const [a, b] = Array.from(pointers.values());
        pinchPrevDist = distance(a, b);
        vp.classList.remove("is-panning");
      }
    });

    vp.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cur = currentImg();
      if (!cur) return;
      if (pointers.size === 1 && state.scale > 1) {
        state.tx = panStartTx + (e.clientX - panStartX);
        state.ty = panStartTy + (e.clientY - panStartY);
        clampPan();
        applyTransform(cur);
      } else if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        const dist = distance(a, b);
        const mid = midpoint(a, b);
        const delta = (dist - pinchPrevDist) / 200;
        if (Math.abs(delta) > 0.001) {
          zoomBy(delta, mid.x, mid.y);
          pinchPrevDist = dist;
        }
      }
    });

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try { vp.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (pointers.size < 2) pinchPrevDist = 0;
      if (pointers.size === 0) vp.classList.remove("is-panning");

      // Single-pointer gesture ended: classify as swipe, double-tap, or nothing.
      if (e.type === "pointerup" && wasSinglePointer && pointers.size === 0) {
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        const dt = e.timeStamp - downTime;
        const moved = Math.hypot(dx, dy);
        const dir = resolveSwipe(dx, dy, state.scale, SWIPE_THRESHOLD);
        if (dir !== 0) {
          goto(dir);
        } else if (moved < TAP_MOVE && dt < TAP_MAX_MS) {
          if (
            e.timeStamp - lastTapTime < DBLTAP_MS &&
            Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < DBLTAP_DIST
          ) {
            toggleZoom(e.clientX, e.clientY);
            lastTapTime = 0;
          } else {
            lastTapTime = e.timeStamp;
            lastTapX = e.clientX;
            lastTapY = e.clientY;
          }
        }
      }
      wasSinglePointer = false;
    };
    vp.addEventListener("pointerup", endPointer);
    vp.addEventListener("pointercancel", endPointer);
    // Note: NO pointerleave — it fires when the pointer exits the viewport during
    // an active drag, which would prematurely cancel the gesture. pointerup +
    // pointercancel cover legitimate end-of-gesture cases.
  }

  // Thumbnail keyboard nav: arrow keys move between thumbs, Enter/Space selects.
  const thumbs = thumbsEl();
  if (thumbs) {
    thumbs.addEventListener("keydown", (e) => {
      const btns = Array.from(thumbs.querySelectorAll<HTMLElement>(".lightbox-thumb"));
      if (!btns.length) return;
      const activeIdx = btns.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowRight" && activeIdx < btns.length - 1) {
        btns[activeIdx + 1].focus();
        e.preventDefault();
      } else if (e.key === "ArrowLeft" && activeIdx > 0) {
        btns[activeIdx - 1].focus();
        e.preventDefault();
      }
    });
  }

  // Browser back closes the dialog. Gate on state.isOpen rather than the dialog's
  // `open` attribute — ui5-dialog reflects open as a property, not a DOM attribute,
  // so hasAttribute("open") returns false even while the dialog is showing.
  window.addEventListener("popstate", () => {
    if (state.isOpen) dlg.open = false;
  });

  // Hash deep-link: open #img-N on page load. Respect document.readyState so
  // cached/fast loads (where DOMContentLoaded already fired before this script
  // ran) are still handled.
  function handleHashOnLoad() {
    const m = location.hash.match(/^#img-(\d+)$/);
    if (!m) return;
    const idx = parseInt(m[1], 10) - 1;
    customElements.whenDefined("ui5-dialog").then(() => {
      const all = collectZoomable();
      if (idx < 0 || idx >= all.length) return;
      const target = all[idx];
      // Scroll the source image into view (so on close, focus restore lands
      // somewhere visible). Block: 'center' prefers vertical centering.
      // Use behavior: "auto" — "instant" is a CSS scroll-behavior keyword, not
      // a valid ScrollIntoViewOptions value (TS will reject it; runtime ignores).
      target.scrollIntoView({ block: "center", behavior: "auto" });
      open(target);
      // Suppress pushState — we entered via URL hash, close should replaceState.
      state.pushedHash = false;
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleHashOnLoad, { once: true });
  } else {
    handleHashOnLoad();
  }
}

/** Test-only surface. Not used by production wiring. */
export const __test__ = {
  formatCounter,
  resolveSwipe,
  nextZoomToggleScale,
  deriveCaption,
  buildThumbs,
  open,
  state,
  reset() {
    state.imgs = [];
    state.index = 0;
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    state.pushedHash = false;
    state.animating = false;
    state.isOpen = false;
    state.triggerEl = null;
    const cur = currentImg();
    if (cur) cur.removeAttribute("src");
  },
};

initLightbox();
