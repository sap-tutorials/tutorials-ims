'use strict';
// Passthrough stub: re-exports from packages/content/img-cdn-fetch.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/img-cdn-fetch.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/img-cdn-fetch.cjs'); // CF-runtime fallback (bundled copy)
}
