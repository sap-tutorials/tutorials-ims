'use strict';
// Passthrough stub: re-exports from packages/content/attachment-mime.cjs (moved T8).
try {
  module.exports = require('@tutorials/content/attachment-mime.cjs');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  module.exports = require('./_shared/attachment-mime.cjs'); // CF-runtime fallback (bundled copy)
}
