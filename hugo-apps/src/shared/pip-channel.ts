// hugo-apps/src/shared/pip-channel.ts
import type { PipMessage, PipSource } from './pip-types';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type OutgoingMessage = DistributiveOmit<PipMessage, 'senderId' | 'source'>;

export type PipChannel = {
  send(msg: OutgoingMessage): void;
  on(handler: (msg: PipMessage) => void): () => void;
  close(): void;
};

export function createPipChannel(slug: string, source: PipSource): PipChannel {
  const channel = new BroadcastChannel(`tutorial-pip:${slug}`);
  const senderId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    send(msg) {
      const stamped = { ...msg, senderId, source } as PipMessage;
      channel.postMessage(stamped);
    },
    on(handler) {
      const listener = (e: MessageEvent<PipMessage>) => {
        if (!e.data || e.data.senderId === senderId) return;
        handler(e.data);
      };
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close() {
      channel.close();
    },
  };
}
