import cds from '@sap/cds';
import { assembleCsvZip } from './assemble-csv-zip.js';
import { assembleXlsx } from './assemble-xlsx.js';

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Placeholder handler installed during 'bootstrap' (before CAP mounts
// ExportsService at /admin/exports). Replaced in 'served' once cds.middlewares
// are available. Without the bootstrap reservation, AdminService's OData
// adapter (mounted at /admin) would intercept /admin/exports/exportLegacyData
// and return "Invalid resource path".
let bridgeHandler = (req, res) => res.status(503).json({ error: 'service_starting' });

export function registerExportsBridge(app) {
  app.get('/admin/exports/exportLegacyData', (req, res, next) => bridgeHandler(req, res, next));
}

export function wireExportsBridge() {
  const contextMw = cds.middlewares?.context?.() || ((req, res, next) => next());
  const authMw    = cds.middlewares?.auth?.()    || ((req, res, next) => next());

  bridgeHandler = (req, res, next) => {
    contextMw(req, res, (err) => {
      if (err) return next(err);
      authMw(req, res, async (err) => {
        if (err) return next(err);
        try {
          const user = cds.context?.user;
          if (!user?.id || user.id === 'anonymous') {
            return res.status(401).json({ error: 'unauthenticated' });
          }
          if (!(user.is && user.is('Admin'))) {
            return res.status(403).json({ error: 'forbidden' });
          }

          const format = String(req.query.format || '').toLowerCase();
          if (format !== 'csv' && format !== 'xlsx') {
            return res.status(400).json({ error: `unsupported format: ${req.query.format}` });
          }

          const ts = timestamp();
          const db = await cds.connect.to('db');

          if (format === 'csv') {
            res.status(200);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="ims-export-csv-${ts}.zip"`);
            await assembleCsvZip(db, res);
          } else {
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="ims-export-${ts}.xlsx"`);
            await assembleXlsx(db, res);
          }
        } catch (err) {
          cds.log('exports').error({ stage: 'bridge', error: err.message, stack: err.stack });
          if (!res.headersSent) res.status(500).json({ error: 'export_failed' });
          else res.end();
        }
      });
    });
  };
}
