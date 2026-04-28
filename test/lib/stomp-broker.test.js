import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseFrame, buildFrame, createStompBroker } from '../../srv/lib/stomp-broker.js';
import { createServer } from 'http';
import { WebSocket } from 'ws';

describe('stomp-broker', () => {

  describe('parseFrame', () => {
    it('parses a CONNECT frame', () => {
      const frame = 'CONNECT\naccept-version:1.2\nhost:localhost\n\n\x00';
      const result = parseFrame(frame);
      expect(result.command).toBe('CONNECT');
      expect(result.headers['accept-version']).toBe('1.2');
      expect(result.headers.host).toBe('localhost');
      expect(result.body).toBe('');
    });

    it('parses a SUBSCRIBE frame', () => {
      const frame = 'SUBSCRIBE\nid:sub-0\ndestination:/topic/events/1/tutorials\n\n\x00';
      const result = parseFrame(frame);
      expect(result.command).toBe('SUBSCRIBE');
      expect(result.headers.id).toBe('sub-0');
      expect(result.headers.destination).toBe('/topic/events/1/tutorials');
    });

    it('parses a frame with body', () => {
      const frame = 'SEND\ndestination:/topic/test\ncontent-type:application/json\n\n{"hello":"world"}\x00';
      const result = parseFrame(frame);
      expect(result.command).toBe('SEND');
      expect(result.body).toBe('{"hello":"world"}');
    });

    it('handles Buffer input', () => {
      const frame = Buffer.from('CONNECT\n\n\x00');
      const result = parseFrame(frame);
      expect(result.command).toBe('CONNECT');
    });
  });

  describe('buildFrame', () => {
    it('builds a CONNECTED frame', () => {
      const frame = buildFrame('CONNECTED', { version: '1.2' });
      expect(frame).toContain('CONNECTED\n');
      expect(frame).toContain('version:1.2\n');
      expect(frame.endsWith('\x00')).toBe(true);
    });

    it('builds a MESSAGE frame with body', () => {
      const frame = buildFrame('MESSAGE', { destination: '/topic/test' }, '{"data":1}');
      expect(frame).toContain('MESSAGE\n');
      expect(frame).toContain('destination:/topic/test\n');
      expect(frame).toContain('\n\n{"data":1}\x00');
    });

    it('builds a frame with no headers or body', () => {
      const frame = buildFrame('RECEIPT');
      expect(frame).toBe('RECEIPT\n\n\x00');
    });
  });

  describe('broker integration', () => {
    let httpServer;
    let broker;
    let port;

    beforeAll(async () => {
      httpServer = createServer();
      broker = createStompBroker(httpServer);
      await new Promise(resolve => httpServer.listen(0, resolve));
      port = httpServer.address().port;
    });

    afterAll(async () => {
      broker.wss.close();
      await new Promise(resolve => httpServer.close(resolve));
    });

    function connectClient(subscriptionTopic) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/display/websocket`);
        const messages = [];

        ws.on('open', () => {
          ws.send('CONNECT\naccept-version:1.2\n\n\x00');
        });

        ws.on('message', (data) => {
          const frame = parseFrame(data);
          if (frame.command === 'CONNECTED') {
            if (subscriptionTopic) {
              ws.send(`SUBSCRIBE\nid:sub-0\ndestination:${subscriptionTopic}\n\n\x00`);
            }
            resolve({ ws, messages, close: () => ws.close() });
          } else if (frame.command === 'MESSAGE') {
            messages.push(frame);
          }
        });

        ws.on('error', reject);
      });
    }

    it('accepts STOMP connection and replies CONNECTED', async () => {
      const client = await connectClient();
      expect(client).toBeDefined();
      client.close();
    });

    it('publishes messages to subscribers', async () => {
      const topic = '/topic/events/42/tutorials';
      const client = await connectClient(topic);

      await new Promise(resolve => setTimeout(resolve, 50));

      const sent = broker.publish(topic, JSON.stringify({ bucketName: 'abap', completeDate: '2026-04-28' }));
      expect(sent).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(client.messages.length).toBe(1);
      expect(client.messages[0].headers.destination).toBe(topic);
      const body = JSON.parse(client.messages[0].body);
      expect(body.bucketName).toBe('abap');
      expect(body.completeDate).toBe('2026-04-28');
      client.close();
    });

    it('does not deliver messages to unsubscribed topics', async () => {
      const client = await connectClient('/topic/events/99/tutorials');
      await new Promise(resolve => setTimeout(resolve, 50));

      broker.publish('/topic/events/100/tutorials', '{"test":true}');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(client.messages.length).toBe(0);
      client.close();
    });

    it('cleans up subscriptions on disconnect', async () => {
      const topic = '/topic/events/77/tutorials';
      const client = await connectClient(topic);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broker.subscriptions.get(topic)?.size).toBe(1);
      client.close();
      await new Promise(resolve => setTimeout(resolve, 50));

      const subs = broker.subscriptions.get(topic);
      expect(!subs || subs.size === 0).toBe(true);
    });

    it('returns 0 when publishing to topic with no subscribers', () => {
      const sent = broker.publish('/topic/nobody', '{}');
      expect(sent).toBe(0);
    });
  });
});
