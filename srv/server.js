import cds from '@sap/cds';
import { registerJobs } from './jobs/scheduler.js';

cds.on('served', () => {
  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
});
