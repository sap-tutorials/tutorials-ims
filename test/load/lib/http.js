// test/load/lib/http.js
// Tagged HTTP GET. Every request in every scenario should go through this
// so that thresholds keyed on {endpoint:...} in config.js actually match.

import http from 'k6/http';
import { tagsFor } from '../config.js';

export function getTagged(url, endpointLabel, extraParams = {}) {
  const params = {
    ...extraParams,
    tags: { ...tagsFor(endpointLabel), ...(extraParams.tags || {}) },
  };
  return http.get(url, params);
}
