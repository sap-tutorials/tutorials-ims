// CJS shim — forwards to packages/channels/normalize.cjs.
// Used by scripts/seed-channels.cjs via require('../srv/lib/channels/normalize.cjs').
const { createRequire } = require('node:module');
const _require = createRequire(require.resolve('@tutorials/channels/package.json'));
module.exports = _require('./normalize.cjs');
