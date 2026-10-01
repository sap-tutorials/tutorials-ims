// CJS shim — forwards to packages/channels/seed-channel-topic-map.cjs.
// Used by scripts/seed-channel-topic-map.cjs via require('../srv/lib/channels/seed-channel-topic-map.cjs').
const { createRequire } = require('node:module');
const _require = createRequire(require.resolve('@tutorials/channels/package.json'));
module.exports = _require('./seed-channel-topic-map.cjs');
