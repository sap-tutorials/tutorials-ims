// test/load/lib/checks.js
// Shared response validators. Each takes the response and a label used
// only for the k6 check-name (so it shows up per-endpoint in the summary).

import { check } from 'k6';

export function checkJson(res, endpointLabel) {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type json`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes('application/json'),
  });
}

export function checkHtml(res, endpointLabel) {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type html`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes('text/html'),
  });
}

export function checkImage(res, endpointLabel, expectedMime = 'image/webp') {
  return check(res, {
    [`${endpointLabel}: status 200`]: (r) => r.status === 200,
    [`${endpointLabel}: content-type ${expectedMime}`]: (r) =>
      (r.headers['Content-Type'] || r.headers['content-type'] || '')
        .toLowerCase()
        .includes(expectedMime),
  });
}
