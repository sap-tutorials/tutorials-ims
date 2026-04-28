import cds from '@sap/cds';
import { registerJobs } from './jobs/scheduler.js';
import { createStompBroker } from './lib/stomp-broker.js';

cds.on('served', () => {
  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
    cds.broker = createStompBroker(cds.server);
  }
});
