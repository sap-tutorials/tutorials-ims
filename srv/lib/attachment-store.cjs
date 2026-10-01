'use strict';
// Passthrough stub: re-exports from packages/content/attachment-store.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/attachment-store.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/attachment-store.cjs'); // CF-runtime fallback (bundled copy)
}
