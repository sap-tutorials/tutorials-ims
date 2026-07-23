import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shimPath = join(__dirname, '../../hugo/static/js/consent-trustarc.js');
const shimCode = readFileSync(shimPath, 'utf8');

/**
 * Load the shim IIFE into a controlled global scope.
 * The shim assigns `window.consent` so we set up globalThis.window / .document
 * before evaluating.
 *
 * We use new Function() so each call gets a fresh evaluation context without
 * side-effects from a previous test leaking through module caches.
 */
function loadShim({ cookie = '', truste = undefined, PrivacyManagerAPI = undefined } = {}) {
  // Stub just enough of window / document for the shim to run safely.
  globalThis.window = {
    truste,
    PrivacyManagerAPI,
    consent: undefined,
  };
  globalThis.document = {
    cookie,
    currentScript: null,
    querySelector: () => null,
  };
  // Safe eval: shimCode is read from a fixed local repository path at module
  // load time (readFileSync above). It is never interpolated with user input,
  // never fetched from the network, and never composed from external variables.
  // eval() is the only practical way to run a browser IIFE that assigns
  // `window.consent` and resolves `window`/`document` from globalThis without
  // a full jsdom environment or bundler transformation.
  // eslint-disable-next-line no-eval
  eval(shimCode);
  return globalThis.window.consent;
}

describe('consent-trustarc shim', () => {
  beforeEach(() => {
    // Clean up globals after each test.
    delete globalThis.window;
    delete globalThis.document;
  });

  it('has("required") === true with no truste and no cookie', () => {
    const consent = loadShim();
    expect(consent.has('required')).toBe(true);
  });

  it('has("advertising") === false with no truste and no cookie', () => {
    const consent = loadShim();
    expect(consent.has('advertising')).toBe(false);
  });

  it('has("functional") === true when cookie permits group 1 and 2 (1-indexed 1,2)', () => {
    // cmapi_cookie_privacy=permit 1,2 → 1-indexed groups 1 (required) and 2 (functional)
    // GROUP map: functional=1 → cookie index 2 → present
    const consent = loadShim({ cookie: 'cmapi_cookie_privacy=permit 1,2' });
    expect(consent.has('functional')).toBe(true);
  });

  it('has("advertising") === false when cookie = "permit 1,2" (group 2 = advertising = index 3, absent)', () => {
    const consent = loadShim({ cookie: 'cmapi_cookie_privacy=permit 1,2' });
    expect(consent.has('advertising')).toBe(false);
  });

  it('has("unknownXyz") === false', () => {
    const consent = loadShim({ cookie: 'cmapi_cookie_privacy=permit 1,2,3' });
    expect(consent.has('unknownXyz')).toBe(false);
  });

  it('evil_cmapi_cookie_privacy=permit 1,2,3 does NOT grant functional (prefix attack)', () => {
    // Only the exact cookie name must match; a prefixed name must be ignored.
    const consent = loadShim({ cookie: 'evil_cmapi_cookie_privacy=permit 1,2,3' });
    expect(consent.has('functional')).toBe(false);
  });

  it('no method throws when window.truste and window.PrivacyManagerAPI are undefined', () => {
    const consent = loadShim();
    expect(() => consent.has('functional')).not.toThrow();
    expect(() => consent.show()).not.toThrow();
    expect(() => consent.onChange(() => {})).not.toThrow();
  });

  it('pre-load subscriber is wired exactly once even when flushPending runs twice', () => {
    // Simulate the async path: register onChange BEFORE truste loads, then trigger
    // the ready path such that flushPending runs twice (wireReady callback + interval).
    // Assert addEventListener('consent', ...) was registered exactly once.
    let listenerCount = 0;
    let readyCallback = null;

    const truste = {
      eu: {
        // Stub addEventListener to count registrations.
        addEventListener: (event, fn) => {
          if (event === 'consent') listenerCount++;
        },
        // Stub runOnReady to store the callback for manual invocation.
        runOnReady: (fn) => {
          readyCallback = fn;
        },
      },
    };

    const consent = loadShim({ truste });

    // Register a subscriber BEFORE truste.eu.runOnReady has fired.
    let changeCount = 0;
    consent.onChange(() => {
      changeCount++;
    });

    // Verify no listener registered yet (truste not ready).
    expect(listenerCount).toBe(0);

    // Simulate the double-flush: invoke the stored readyCallback AND manually
    // call flushPending a second time to replicate the interval + runOnReady race.
    // With the fix, subscribers.length=0 after the first flush, so the second
    // is a no-op.
    if (readyCallback) readyCallback();
    if (readyCallback) readyCallback(); // second flush (simulating interval firing too)

    // With the fix in place, listener should be registered exactly once.
    expect(listenerCount).toBe(1);
  });
});
