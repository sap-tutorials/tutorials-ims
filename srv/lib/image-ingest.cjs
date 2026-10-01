'use strict';
// Passthrough stub: re-exports from packages/content/image-ingest.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/image-ingest.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/image-ingest.cjs'); // CF-runtime fallback (bundled copy)
}
