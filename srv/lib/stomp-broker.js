import { WebSocketServer } from 'ws';
import cds from '@sap/cds';

const NULL_BYTE = '\x00';
const LOG = cds.log('stomp-broker');

export function parseFrame(data) {
  const str = typeof data === 'string' ? data : data.toString();
  const cleaned = str.replace(/\x00$/, '');
  const divider = cleaned.indexOf('\n\n');
  const headerBlock = divider >= 0 ? cleaned.slice(0, divider) : cleaned;
  const body = divider >= 0 ? cleaned.slice(divider + 2) : '';
  const lines = headerBlock.split('\n');
  const command = lines[0];
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon > 0) {
      headers[lines[i].slice(0, colon)] = lines[i].slice(colon + 1);
    }
  }
  return { command, headers, body };
}

export function buildFrame(command, headers = {}, body = '') {
  let frame = command + '\n';
  for (const [key, value] of Object.entries(headers)) {
    frame += `${key}:${value}\n`;
  }
  frame += '\n' + body + NULL_BYTE;
  return frame;
}

export function createStompBroker(httpServer) {
  const subscriptions = new Map();
  let messageId = 0;

  const wss = new WebSocketServer({ server: httpServer, path: '/display/websocket' });

  wss.on('connection', (ws) => {
    LOG.info('Client connected');

    ws.on('message', (data) => {
      const frame = parseFrame(data);

      switch (frame.command) {
        case 'CONNECT':
        case 'STOMP':
          ws.send(buildFrame('CONNECTED', {
            version: '1.2',
            'heart-beat': '10000,10000'
          }));
          break;

        case 'SUBSCRIBE': {
          const destination = frame.headers.destination;
          const id = frame.headers.id;
          if (!destination) break;
          if (!subscriptions.has(destination)) {
            subscriptions.set(destination, new Set());
          }
          subscriptions.get(destination).add({ ws, id });
          LOG.info('Subscribed to', destination);
          break;
        }

        case 'UNSUBSCRIBE': {
          const id = frame.headers.id;
          for (const [topic, subs] of subscriptions) {
            for (const sub of subs) {
              if (sub.ws === ws && sub.id === id) {
                subs.delete(sub);
                break;
              }
            }
          }
          break;
        }

        case 'DISCONNECT':
          ws.close();
          break;
      }
    });

    ws.on('close', () => {
      for (const [topic, subs] of subscriptions) {
        for (const sub of subs) {
          if (sub.ws === ws) subs.delete(sub);
        }
        if (subs.size === 0) subscriptions.delete(topic);
      }
      LOG.info('Client disconnected');
    });
  });

  function publish(topic, body) {
    const subs = subscriptions.get(topic);
    if (!subs || subs.size === 0) return 0;

    const frame = buildFrame('MESSAGE', {
      destination: topic,
      'message-id': String(++messageId),
      'content-type': 'application/json'
    }, body);

    let sent = 0;
    for (const { ws, id } of subs) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame.replace('\n\n', `\nsubscription:${id}\n\n`));
        sent++;
      }
    }
    return sent;
  }

  return { wss, publish, subscriptions };
}
