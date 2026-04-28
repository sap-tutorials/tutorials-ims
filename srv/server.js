import cds from '@sap/cds';
import { registerJobs } from './jobs/scheduler.js';
import { createStompBroker } from './lib/stomp-broker.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';

cds.on('bootstrap', (app) => {
  app.get('/api/qrcode', qrcodeHandler);
  app.get('/build/catalog', buildCatalogHandler);
});

cds.on('served', () => {
  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
    cds.broker = createStompBroker(cds.server);
  }
});
