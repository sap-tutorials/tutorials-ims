'use strict';
// Passthrough stub: re-exports from packages/content/img-cdn-retry.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/img-cdn-retry.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/img-cdn-retry.cjs'); // CF-runtime fallback (bundled copy)
}
