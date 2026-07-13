// test/load/lib/http.js
// Tagged HTTP GET. Every request in every scenario should go through this
// so that thresholds keyed on {endpoint:...} in config.js actually match.

import http from 'k6/http';
import { tagsFor } from '../config.js';

export function getTagged(url, endpointLabel, extraParams = {}) {
  // NOTE: k6 0.51.0's bundled Babel transpiler does not support object spread
  // in object literals ({...x}), so build params with Object.assign instead.
  const tags = Object.assign({}, tagsFor(endpointLabel), extraParams.tags || {});
  const params = Object.assign({}, extraParams, { tags: tags });
  return http.get(url, params);
}
