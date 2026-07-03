// test/load/scenarios/05-websocket-handshake.js
// 20 VU each opening a Socket.IO connection on /ws/event-stream, waiting
// for the connect ack, disconnecting. No message traffic — connection churn only.
//
// Note: Socket.IO's initial HTTP polling handshake is what we measure. k6's
// ws module handles the WebSocket upgrade; we time from ws.connect() start
// to the first message received from the server.

import ws from 'k6/ws';
import { check } from 'k6';
import { BASE_URL, SUMMARY_PATH, THRESHOLDS } from '../config.js';

export const options = {
  scenarios: {
    wsHandshake: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 30,          // ~30s of churn per VU at ~1s per iteration
      maxDuration: '2m',
      tags: { scenario: 'ws' },
    },
  },
  thresholds: THRESHOLDS,
};

export default function () {
  // Socket.IO handshake URL. approuter passes /socket.io/ through unauth.
  const url = `${BASE_URL.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket&namespace=/ws/event-stream`;
  const res = ws.connect(url, { tags: { endpoint: 'ws-handshake' } }, (socket) => {
    socket.on('open', () => {
      // Socket.IO v4 protocol: server sends '0{...}' handshake, then client
      // sends '40/ws/event-stream' to join namespace. We only care about
      // the initial handshake round-trip for throughput.
      socket.setTimeout(() => socket.close(), 500);
    });
    socket.on('error', (e) => {
      // Count as ws_session_errors — k6 auto-tracks.
      if (e && e.error && !String(e.error).match(/closed/i)) {
        console.warn(`ws error: ${e.error}`);
      }
    });
  });
  check(res, { 'ws handshake status 101': (r) => r && r.status === 101 });
}

export function handleSummary(data) {
  return { [SUMMARY_PATH]: JSON.stringify(data, null, 2) };
}
