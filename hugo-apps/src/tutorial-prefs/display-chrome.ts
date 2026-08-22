import {
  getHeaderPref, getFooterPref, getBreadcrumbsPref, getFeedbackPref,
  getTextSize, getReadWidth, getCodeSize, getCodeWrap, getImgSize, getImgCollapse, getReduceMotion, getReadableFont
} from './prefs-store';
import {
  SHORT_VIEWPORT_MAX_HEIGHT, type HeaderMode, type FooterMode, type OnOff, type SizeStep, type ReadWidth
} from './constants';

export interface DisplayPrefs {
  header: HeaderMode | null;
  footer: FooterMode | null;
  breadcrumbs: OnOff;
  feedback: OnOff;
  textSize: SizeStep;
  readWidth: ReadWidth;
  codeSize: SizeStep;
  codeWrap: OnOff;
  imgSize: SizeStep;
  imgCollapse: OnOff;
  reduceMotion: OnOff;
  readableFont: OnOff;
}
export interface Effective {
  header: HeaderMode;
  footer: FooterMode;
  breadcrumbs: OnOff;
  feedback: OnOff;
  textSize: SizeStep;
  readWidth: ReadWidth;
  codeSize: SizeStep;
  codeWrap: OnOff;
  imgSize: SizeStep;
  imgCollapse: OnOff;
  reduceMotion: OnOff;
  readableFont: OnOff;
}

export function computeEffective(prefs: DisplayPrefs, shortViewport: boolean): Effective {
  return {
    header: prefs.header ?? (shortViewport ? 'thinbar' : 'locked'),
    footer: prefs.footer ?? (shortViewport ? 'autohide' : 'shown'),
    breadcrumbs: prefs.breadcrumbs,
    feedback: prefs.feedback,
    textSize: prefs.textSize,
    readWidth: prefs.readWidth,
    codeSize: prefs.codeSize,
    codeWrap: prefs.codeWrap,
    imgSize: prefs.imgSize,
    imgCollapse: prefs.imgCollapse,
    reduceMotion: prefs.reduceMotion,
    readableFont: prefs.readableFont
  };
}

export function readPrefs(): DisplayPrefs {
  return {
    header: getHeaderPref(),
    footer: getFooterPref(),
    breadcrumbs: getBreadcrumbsPref(),
    feedback: getFeedbackPref(),
    textSize: getTextSize(),
    readWidth: getReadWidth(),
    codeSize: getCodeSize(),
    codeWrap: getCodeWrap(),
    imgSize: getImgSize(),
    imgCollapse: getImgCollapse(),
    reduceMotion: getReduceMotion(),
    readableFont: getReadableFont()
  };
}

export function isShortViewport(): boolean {
  try {
    return typeof matchMedia === 'function'
      && matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`).matches;
  } catch { return false; }
}

export function applyDisplayChrome(doc: Document = document): void {
  const eff = computeEffective(readPrefs(), isShortViewport());
  const html = doc.documentElement;
  html.setAttribute('data-tut-header', eff.header);
  html.setAttribute('data-tut-footer', eff.footer);
  html.setAttribute('data-tut-breadcrumbs', eff.breadcrumbs);
  html.setAttribute('data-tut-feedback', eff.feedback);
  html.setAttribute('data-tut-text-size', eff.textSize);
  html.setAttribute('data-tut-read-width', eff.readWidth);
  html.setAttribute('data-tut-code-size', eff.codeSize);
  html.setAttribute('data-tut-code-wrap', eff.codeWrap);
  html.setAttribute('data-tut-img-size', eff.imgSize);
  html.setAttribute('data-tut-img-collapse', eff.imgCollapse);
  html.setAttribute('data-tut-reduce-motion', eff.reduceMotion);
  html.setAttribute('data-tut-readable-font', eff.readableFont);
}

export function installAutoHide(doc: Document = document): () => void {
  const html = doc.documentElement;
  let lastY = typeof window !== 'undefined' ? window.scrollY : 0;
  const HIDE_AFTER = 80; // px scrolled before hiding

  const onScroll = () => {
    if (html.getAttribute('data-tut-header') !== 'autohide') {
      html.removeAttribute('data-tut-header-hidden');
      return;
    }
    const y = window.scrollY;
    if (y <= HIDE_AFTER) {
      html.removeAttribute('data-tut-header-hidden');       // near top → always show
    } else if (y > lastY) {
      html.setAttribute('data-tut-header-hidden', '');      // scrolling down → hide
    } else if (y < lastY) {
      html.removeAttribute('data-tut-header-hidden');       // scrolling up → show
    }
    lastY = y;
  };

  const mql = (typeof matchMedia === 'function')
    ? matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`) : null;
  const onMedia = () => applyDisplayChrome(doc);

  window.addEventListener('scroll', onScroll, { passive: true });
  mql?.addEventListener?.('change', onMedia);

  return () => {
    window.removeEventListener('scroll', onScroll);
    mql?.removeEventListener?.('change', onMedia);
  };
}
