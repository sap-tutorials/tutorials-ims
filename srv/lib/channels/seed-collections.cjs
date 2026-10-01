// CJS shim — forwards to packages/channels/seed-collections.cjs.
// Used by scripts/seed-collections.cjs via require('../srv/lib/channels/seed-collections.cjs').
const { createRequire } = require('node:module');
const _require = createRequire(require.resolve('@tutorials/channels/package.json'));
module.exports = _require('./seed-collections.cjs');
