import cds from '@sap/cds';
import { registerJobs } from './jobs/scheduler.js';
import { createStompBroker } from './lib/stomp-broker.js';
import { qrcodeHandler } from './lib/qrcode-handler.js';
import { buildCatalogHandler } from './lib/build-catalog.js';
import { navigatorCatalogHandler } from './lib/navigator-catalog.js';
import { basicAuthMiddleware } from './lib/tech-user-auth.js';

cds.on('bootstrap', (app) => {
  if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }
  app.use(basicAuthMiddleware);
  app.get('/api/qrcode', qrcodeHandler);
  app.get('/build/catalog', buildCatalogHandler);
  app.get('/build/navigator', navigatorCatalogHandler);
});

cds.on('served', () => {
  const app = cds.app;
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw = cds.middlewares?.auth?.() || ((req, res, next) => next());

  app.get('/auth/user', contextMw, authMw, (req, res) => {
    const user = cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ authenticated: false });
    }
    const email = user.attr?.email || '';
    res.json({
      authenticated: true,
      id: user.id,
      email,
      givenName: user.attr?.given_name || '',
      familyName: user.attr?.family_name || '',
      avatarUrl: email
        ? `https://people-api.services.sap.com/rs/avatar/${encodeURIComponent(email)}`
        : null
    });
  });

  if (process.env.NODE_ENV !== 'test') {
    registerJobs();
  }
});

cds.on('listening', ({ server }) => {
  if (process.env.NODE_ENV !== 'test') {
    cds.broker = createStompBroker(server);
  }
});
