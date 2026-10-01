'use strict';
// Passthrough stub: re-exports from packages/content/attachment-ingest.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/attachment-ingest.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/attachment-ingest.cjs'); // CF-runtime fallback (bundled copy)
}
