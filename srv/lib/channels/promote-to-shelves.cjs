// CJS shim — forwards to packages/channels/promote-to-shelves.cjs.
// Used by scripts/promote-channels-to-shelves.cjs via require('../srv/lib/channels/promote-to-shelves.cjs').
const { createRequire } = require('node:module');
const _require = createRequire(require.resolve('@tutorials/channels/package.json'));
module.exports = _require('./promote-to-shelves.cjs');
