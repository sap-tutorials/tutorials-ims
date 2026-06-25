/**
 * Cookie & storage consent banner.
 *
 * Self-contained — single file, no external deps, embedded CSS.
 * Designed to be ripped out cleanly when SAP Legal mandates the corporate CMP.
 *
 * Banner shape mirrors the production SAP banner on developers.sap.com:
 *   "Understood" (accept all non-required) + "Manage Settings" (open dialog) + close (X).
 * Categories: Required / Functional / Advertising.
 *
 * Storage shape (localStorage key 'consent.v1'):
 *   { v: 1, ts: <iso>, categories: { required, functional, advertising } }
 *
 * Public API: window.consent
 *   consent.has(category)  - returns true if user has consented to that category
 *   consent.show()         - reopen the banner (used by "Manage cookies" footer link)
 *   consent.onChange(fn)   - subscribe to consent changes (called with categories object)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'consent.v1';
  const VERSION = 1;
  const CATEGORIES = ['required', 'functional', 'advertising'];
  const PRIVACY_URL = 'https://www.sap.com/about/legal/privacy.html';
  const COOKIES_URL = 'https://www.sap.com/about/legal/privacy/cookies.html';
  const subscribers = [];
  let bannerEl = null;
  let dialogEl = null;

  function readConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || obj.v !== VERSION || !obj.categories) return null;
      return obj;
    } catch { return null; }
  }

  function writeConsent(categories) {
    const record = {
      v: VERSION,
      ts: new Date().toISOString(),
      categories: Object.assign({ required: true }, categories),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch {}
    subscribers.forEach(fn => { try { fn(record.categories); } catch {} });
    return record;
  }

  function injectStyles() {
    if (document.getElementById('consent-banner-styles')) return;
    const style = document.createElement('style');
    style.id = 'consent-banner-styles';
    style.textContent = `
      .consent-banner { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10000;
        background: var(--sapBaseColor, #fff); color: var(--sapTextColor, #1a1a1a);
        border-top: 1px solid var(--sapList_BorderColor, #e5e5e5);
        box-shadow: 0 -4px 16px rgba(0,0,0,.08); padding: 1rem 1.5rem;
        font-size: 0.9rem; line-height: 1.45; }
      .consent-banner__inner { max-width: 1200px; margin: 0 auto; position: relative;
        display: grid; grid-template-columns: 1fr auto auto; gap: 1rem 1.5rem; align-items: start; }
      .consent-banner__text { min-width: 0; }
      .consent-banner__text p { margin: 0 0 0.5rem; }
      .consent-banner__text p:last-child { margin: 0; }
      .consent-banner__text a { color: var(--sapLink_Color, #0070f3); }
      .consent-banner__legal { font-size: 0.85rem; }
      .consent-banner__legal a { margin-right: 0.5rem; }
      .consent-banner__legal a + a { margin-left: 0.5rem; border-left: 1px solid var(--sapList_BorderColor, #c5c5c5); padding-left: 1rem; }
      .consent-banner__btn { font: inherit; padding: 0.5rem 1rem; border-radius: 4px;
        border: 1px solid var(--sapButton_BorderColor, #999); background: var(--sapButton_Background, #fff);
        color: var(--sapButton_TextColor, #1a1a1a); cursor: pointer; min-width: 7rem; }
      .consent-banner__btn:hover { background: var(--sapButton_Hover_Background, #f0f0f0); }
      .consent-banner__btn--primary { background: var(--sapButton_Emphasized_Background, #0070f3);
        color: var(--sapButton_Emphasized_TextColor, #fff); border-color: var(--sapButton_Emphasized_BorderColor, #0070f3); }
      .consent-banner__btn--primary:hover { background: var(--sapButton_Emphasized_Hover_Background, #0058c8); }
      .consent-banner__close { position: absolute; top: -0.25rem; right: 0;
        background: none; border: 0; font-size: 1.5rem; line-height: 1; cursor: pointer;
        color: inherit; padding: 0.25rem 0.5rem; }
      .consent-banner__close:hover { color: var(--sapLink_Color, #0070f3); }

      /* Mobile portrait fix: the inner grid is "1fr auto auto", so two auto
         button columns (min-width 7rem each) plus gaps leave the text column
         around 70px on a ~390px viewport, wrapping one word per line and
         making the banner taller than the screen. Collapse to a single column,
         stretch buttons full-width, and re-anchor the X to the banner itself
         (not the inner grid) so it stays in the corner. Landscape on the same
         device is ~850px wide, so the desktop 3-column layout still applies. */
      @media (max-width: 600px) {
        .consent-banner { padding: 0.75rem 1rem 1rem; }
        .consent-banner__inner { grid-template-columns: 1fr; gap: 0.75rem; padding-right: 2rem; }
        .consent-banner__btn { width: 100%; min-width: 0; }
        .consent-banner__close { top: 0.25rem; right: 0.5rem; }
      }

      .consent-dialog__backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10001;
        display: flex; align-items: center; justify-content: center; padding: 1rem; }
      .consent-dialog { background: var(--sapBaseColor, #fff); color: var(--sapTextColor, #1a1a1a);
        border-radius: 6px; max-width: 720px; width: 100%; max-height: 90vh;
        display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
      .consent-dialog__head { padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--sapList_BorderColor, #e5e5e5);
        display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      .consent-dialog__head h2 { margin: 0; font-size: 1.15rem; }
      .consent-dialog__head button { background: none; border: 0; font-size: 1.5rem; line-height: 1;
        cursor: pointer; color: inherit; padding: 0.25rem 0.5rem; }
      .consent-dialog__body { padding: 1.25rem 1.5rem; overflow-y: auto; flex: 1 1 auto; }
      .consent-dialog__body > p { margin: 0 0 1rem; }
      .consent-dialog__category { border: 1px solid var(--sapList_BorderColor, #e5e5e5);
        border-radius: 4px; padding: 1rem; margin-bottom: 0.75rem;
        display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; }
      .consent-dialog__category h3 { margin: 0 0 0.25rem; font-size: 1rem; }
      .consent-dialog__category p { margin: 0 0 0.25rem; font-size: 0.9rem;
        color: var(--sapNeutralTextColor, #555); }
      .consent-dialog__category a { font-size: 0.85rem; color: var(--sapLink_Color, #0070f3); }
      .consent-dialog__toggle { flex: 0 0 auto; }
      .consent-dialog__toggle small { display: block; font-weight: 600; font-size: 0.8rem;
        color: var(--sapNeutralTextColor, #666); }
      .consent-dialog__foot { padding: 1rem 1.5rem; border-top: 1px solid var(--sapList_BorderColor, #e5e5e5);
        display: flex; gap: 0.5rem; justify-content: flex-end; flex-wrap: wrap; }

      [data-theme="dark"] .consent-banner,
      [data-theme="dark"] .consent-dialog { background: var(--sapBaseColor, #1c2228);
        color: var(--sapTextColor, #eaecee); }
    `;
    document.head.appendChild(style);
  }

  function mkBtn(text, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    return b;
  }

  function mkLink(href, text, opts) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    if (opts && opts.external) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  function buildBanner() {
    const wrap = document.createElement('div');
    wrap.className = 'consent-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-labelledby', 'consent-banner-desc');

    const inner = document.createElement('div');
    inner.className = 'consent-banner__inner';
    wrap.appendChild(inner);

    const text = document.createElement('div');
    text.className = 'consent-banner__text';
    inner.appendChild(text);

    const desc = document.createElement('p');
    desc.id = 'consent-banner-desc';
    desc.appendChild(document.createTextNode(
      'This site uses cookies and related technologies, as described in our Cookie Statement, ' +
      'for purposes that may include site operation, analytics, enhanced user experience, or advertising. ' +
      'You may choose to consent to our use of these technologies, or manage your own preferences.'
    ));
    text.appendChild(desc);

    const legal = document.createElement('p');
    legal.className = 'consent-banner__legal';
    legal.appendChild(mkLink(PRIVACY_URL, 'Privacy Statement', { external: true }));
    legal.appendChild(mkLink(COOKIES_URL, 'Cookie Statement', { external: true }));
    text.appendChild(legal);

    const understoodBtn = mkBtn('Understood', 'consent-banner__btn consent-banner__btn--primary');
    const manageBtn = mkBtn('Manage Settings', 'consent-banner__btn');
    inner.appendChild(understoodBtn);
    inner.appendChild(manageBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'consent-banner__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    inner.appendChild(closeBtn);

    understoodBtn.addEventListener('click', () => {
      writeConsent({ functional: true, advertising: true });
      hide();
    });
    manageBtn.addEventListener('click', () => {
      showDialog();
    });
    closeBtn.addEventListener('click', () => {
      hide();
    });

    return wrap;
  }

  function buildDialog(currentConsent) {
    const meta = {
      required: {
        title: 'Required Cookies',
        desc: 'These cookies are required to enable core site functionality, such as keeping you signed in and routing your requests.',
        locked: true,
      },
      functional: {
        title: 'Functional Cookies',
        desc: 'These cookies and storage entries remember your preferences (theme, chat history). No personal data leaves your browser.',
        locked: false,
      },
      advertising: {
        title: 'Advertising Cookies',
        desc: 'These cookies are used by advertising companies to serve ads that are relevant to your interests. Currently unused on this site.',
        locked: false,
      },
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'consent-dialog__backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'consent-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'consent-dialog-title');
    backdrop.appendChild(dialog);

    const head = document.createElement('div');
    head.className = 'consent-dialog__head';
    const title = document.createElement('h2');
    title.id = 'consent-dialog-title';
    title.textContent = 'Your choices regarding cookies on this site';
    head.appendChild(title);
    const headClose = document.createElement('button');
    headClose.type = 'button';
    headClose.setAttribute('aria-label', 'Close');
    headClose.textContent = '✕';
    head.appendChild(headClose);
    dialog.appendChild(head);

    const body = document.createElement('div');
    body.className = 'consent-dialog__body';
    dialog.appendChild(body);

    const intro = document.createElement('p');
    intro.textContent = 'Please choose whether this site may use Functional and/or Advertising cookies, as described below.';
    body.appendChild(intro);

    const checkboxes = {};
    CATEGORIES.forEach(cat => {
      const row = document.createElement('div');
      row.className = 'consent-dialog__category';
      const left = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = meta[cat].title;
      const p = document.createElement('p');
      p.textContent = meta[cat].desc;
      const link = mkLink('/cookies/#' + cat, 'View cookies');
      left.appendChild(h);
      left.appendChild(p);
      left.appendChild(link);
      row.appendChild(left);

      const toggle = document.createElement('label');
      toggle.className = 'consent-dialog__toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = meta[cat].locked
        ? true
        : (currentConsent && currentConsent.categories[cat]) || false;
      cb.disabled = meta[cat].locked;
      const small = document.createElement('small');
      small.textContent = meta[cat].locked ? 'Always Active' : '';
      checkboxes[cat] = cb;
      toggle.appendChild(cb);
      toggle.appendChild(small);
      row.appendChild(toggle);

      body.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'consent-dialog__foot';
    const cancelBtn = mkBtn('Cancel', 'consent-banner__btn');
    const submitBtn = mkBtn('Submit Preferences', 'consent-banner__btn consent-banner__btn--primary');
    foot.appendChild(cancelBtn);
    foot.appendChild(submitBtn);
    dialog.appendChild(foot);

    headClose.addEventListener('click', hideDialog);
    cancelBtn.addEventListener('click', hideDialog);
    submitBtn.addEventListener('click', () => {
      const chosen = {};
      CATEGORIES.forEach(cat => { chosen[cat] = !!checkboxes[cat].checked; });
      writeConsent(chosen);
      hideDialog();
      hide();
    });
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) hideDialog();
    });

    return backdrop;
  }

  function show() {
    if (bannerEl) return;
    injectStyles();
    bannerEl = buildBanner();
    document.body.appendChild(bannerEl);
  }

  function hide() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  function showDialog() {
    injectStyles();
    if (dialogEl) return;
    dialogEl = buildDialog(readConsent());
    document.body.appendChild(dialogEl);
  }

  function hideDialog() {
    if (dialogEl && dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    dialogEl = null;
  }

  function init() {
    const current = readConsent();
    if (!current) show();
  }

  window.consent = {
    has(category) {
      const c = readConsent();
      if (!c) return category === 'required';
      return !!c.categories[category];
    },
    show() {
      const current = readConsent();
      if (current) showDialog();
      else show();
    },
    onChange(fn) { if (typeof fn === 'function') subscribers.push(fn); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
