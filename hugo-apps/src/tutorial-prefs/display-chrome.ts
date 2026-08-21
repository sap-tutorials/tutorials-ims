import {
  getHeaderPref, getFooterPref, getBreadcrumbsPref, getFeedbackPref
} from './prefs-store';
import {
  SHORT_VIEWPORT_MAX_HEIGHT, type HeaderMode, type FooterMode, type OnOff
} from './constants';

export interface DisplayPrefs {
  header: HeaderMode | null;
  footer: FooterMode | null;
  breadcrumbs: OnOff;
  feedback: OnOff;
}
export interface Effective {
  header: HeaderMode;
  footer: FooterMode;
  breadcrumbs: OnOff;
  feedback: OnOff;
}

export function computeEffective(prefs: DisplayPrefs, shortViewport: boolean): Effective {
  return {
    header: prefs.header ?? (shortViewport ? 'thinbar' : 'locked'),
    footer: prefs.footer ?? (shortViewport ? 'autohide' : 'shown'),
    breadcrumbs: prefs.breadcrumbs,
    feedback: prefs.feedback
  };
}

export function readPrefs(): DisplayPrefs {
  return {
    header: getHeaderPref(),
    footer: getFooterPref(),
    breadcrumbs: getBreadcrumbsPref(),
    feedback: getFeedbackPref()
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
}
