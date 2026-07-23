/**
 * window.consent.* compatibility shim over the TrustArc CMP.
 *
 * Preserves the API shape of hugo/static/js/consent.js so the footer
 * "Cookie Preferences" button (footer.html:37) and any future has()/onChange()
 * callers keep working unchanged when cmp=trustarc.
 *
 * Category map: required=group 0, functional=group 1, advertising=group 2
 * (TrustArc numeric consent groups, confirmed from live sapshared.com property).
 *
 * Never throws — degrades to "required-only" if TrustArc globals are absent.
 */
(function () {
  'use strict';

  var GROUP = { required: 0, functional: 1, advertising: 2 };
  var pending = [];
  var subscribers = [];

  function taDomain() {
    var s = document.currentScript || document.querySelector('script[data-ta-domain]');
    return (s && s.getAttribute('data-ta-domain')) || 'sapshared.com';
  }

  // Parse "permit 1,2,3" style cmapi cookie → set of permitted group numbers.
  function permittedFromCookie() {
    try {
      var m = document.cookie.match(/cmapi_cookie_privacy=permit ([0-9,]+)/);
      if (!m) return null;
      var set = {};
      m[1].split(',').forEach(function (n) { set[parseInt(n, 10)] = true; });
      return set;
    } catch (e) { return null; }
  }

  function hasCategory(category) {
    var group = GROUP[category];
    if (group === 0 || group === undefined) return true; // required always on
    // Preferred: PrivacyManagerAPI structured decision.
    try {
      if (window.PrivacyManagerAPI && typeof window.PrivacyManagerAPI.callApi === 'function') {
        var d = window.PrivacyManagerAPI.callApi('getConsentDecision', taDomain());
        if (d && Array.isArray(d.consentDecision)) return d.consentDecision.indexOf(group) !== -1;
        // Some builds return a max-permitted integer; treat >=group as consented.
        if (d && typeof d.consentDecision === 'number') return d.consentDecision >= group + 1;
      }
    } catch (e) { /* fall through to cookie */ }
    var permitted = permittedFromCookie();
    if (permitted) return !!permitted[group + 1]; // cmapi is 1-indexed (1,2,3)
    return false; // unknown → not consented (safe default for non-required)
  }

  function show() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.reopenBanner === 'function') {
        window.truste.eu.reopenBanner();
        return;
      }
    } catch (e) { /* not ready */ }
    pending.push(show); // queue until truste is ready
  }

  function flushPending() {
    var q = pending.slice(); pending.length = 0;
    q.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    subscribers.push(fn);
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.addEventListener === 'function') {
        window.truste.eu.addEventListener('consent', function () {
          try { fn(readCategories()); } catch (e) {}
        });
      }
    } catch (e) { /* addEventListener absent → no live updates, has() still works */ }
  }

  function readCategories() {
    return {
      required: true,
      functional: hasCategory('functional'),
      advertising: hasCategory('advertising'),
    };
  }

  window.consent = {
    has: function (category) { return hasCategory(category); },
    show: show,
    onChange: onChange,
  };

  // When TrustArc finishes loading, flush any queued show() calls.
  // truste.eu.runOnReady exists on the live property; guard for absence.
  function wireReady() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.runOnReady === 'function') {
        window.truste.eu.runOnReady(flushPending);
        return true;
      }
    } catch (e) {}
    return false;
  }
  if (!wireReady()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (wireReady() || ++tries > 40) { clearInterval(iv); flushPending(); }
    }, 250); // up to ~10s, then give up and flush best-effort
  }
})();
