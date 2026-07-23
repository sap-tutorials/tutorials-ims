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
  // pending: boolean flag — at most one queued show() before truste loads.
  var pendingShow = false;
  var subscribers = [];
  // Track whether we have already wired the ready path so we never double-wire.
  var trusteReady = false;

  function taDomain() {
    var s = document.currentScript || document.querySelector('script[data-ta-domain]');
    return (s && s.getAttribute('data-ta-domain')) || 'sapshared.com';
  }

  // Parse "permit 1,2,3" style cmapi cookie → set of permitted group numbers.
  // Splits on /;\s*/ and requires EXACT cookie name match to avoid matching
  // evil_cmapi_cookie_privacy= or similar prefixes.
  function permittedFromCookie() {
    try {
      var cookies = document.cookie.split(/;\s*/);
      for (var i = 0; i < cookies.length; i++) {
        var eq = cookies[i].indexOf('=');
        if (eq === -1) continue;
        var name = cookies[i].slice(0, eq).trim();
        if (name !== 'cmapi_cookie_privacy') continue;
        var value = cookies[i].slice(eq + 1).trim();
        var m = value.match(/^permit ([0-9,]+)$/);
        if (!m) return null;
        var set = {};
        m[1].split(',').forEach(function (n) { set[parseInt(n, 10)] = true; });
        return set;
      }
      return null;
    } catch (e) { return null; }
  }

  function hasCategory(category) {
    var group = GROUP[category];
    // required (group 0) is always on.
    if (category === 'required' || group === 0) return true;
    // Unknown category — not in GROUP map → not consented.
    if (group === undefined) return false;

    // PRIMARY signal: deterministic cmapi cookie.
    // Live sapshared.com observed shape: cmapi_cookie_privacy="permit 1,2,3"
    // (1-indexed, 1=required, 2=functional, 3=advertising).
    var permitted = permittedFromCookie();
    if (permitted !== null) return !!permitted[group + 1]; // cmapi is 1-indexed

    // FALLBACK: PrivacyManagerAPI when cookie is absent.
    // Observed live shape: { consentDecision: 3, source: 'asserted' } — a NUMBER.
    // Also handle array shape defensively.
    try {
      if (window.PrivacyManagerAPI && typeof window.PrivacyManagerAPI.callApi === 'function') {
        var d = window.PrivacyManagerAPI.callApi('getConsentDecision', taDomain());
        if (d && Array.isArray(d.consentDecision)) {
          // Array branch: match 1-indexed convention (group+1) to align with cookie.
          return d.consentDecision.indexOf(group + 1) !== -1;
        }
        // Numeric or other unrecognized shape → safe default: not consented.
        return false;
      }
    } catch (e) { /* fall through */ }
    return false; // unknown → not consented
  }

  function show() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.reopenBanner === 'function') {
        window.truste.eu.reopenBanner();
        return;
      }
    } catch (e) { /* not ready */ }
    pendingShow = true; // deduplicated — at most one flush call
  }

  function flushPending() {
    // Wire any subscribers registered before truste was ready.
    subscribers.forEach(function (fn) {
      try {
        if (window.truste && window.truste.eu && typeof window.truste.eu.addEventListener === 'function') {
          window.truste.eu.addEventListener('consent', function () {
            try { fn(readCategories()); } catch (e) {}
          });
        }
      } catch (e) {}
    });
    // Flush exactly one pending show() if queued.
    if (pendingShow) {
      pendingShow = false;
      try {
        if (window.truste && window.truste.eu && typeof window.truste.eu.reopenBanner === 'function') {
          window.truste.eu.reopenBanner();
        }
      } catch (e) {}
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    if (trusteReady) {
      // truste already available — wire immediately, do not add to subscribers.
      try {
        if (window.truste && window.truste.eu && typeof window.truste.eu.addEventListener === 'function') {
          window.truste.eu.addEventListener('consent', function () {
            try { fn(readCategories()); } catch (e) {}
          });
        }
      } catch (e) { /* addEventListener absent → no live updates, has() still works */ }
      return;
    }
    // Pre-load registration — will be wired in flushPending() on the ready path.
    subscribers.push(fn);
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

  // When TrustArc finishes loading, flush any queued show() calls and wire
  // any pre-registered onChange subscribers.
  // truste.eu.runOnReady exists on the live property; guard for absence.
  function wireReady() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.runOnReady === 'function') {
        window.truste.eu.runOnReady(function () {
          trusteReady = true;
          flushPending();
        });
        return true;
      }
    } catch (e) {}
    return false;
  }
  if (!wireReady()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (wireReady() || ++tries > 40) {
        clearInterval(iv);
        trusteReady = true;
        flushPending();
      }
    }, 250); // up to ~10s, then give up and flush best-effort
  }
})();
