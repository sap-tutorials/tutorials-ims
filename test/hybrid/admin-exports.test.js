import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('admin exports (hybrid HANA)', () => {
  it('csv: returns ZIP with 6 IMS_*.csv entries', async () => {
    const { status, headers, data } = await project.get(
      '/admin/exports/exportLegacyData?format=csv',
      { ...adminAuth, responseType: 'arraybuffer' }
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('application/zip');

    const names = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(Buffer.from(data), { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on('entry', (e) => {
          out.push(e.fileName);
          zip.readEntry();
        });
        zip.on('end', () => resolve(out));
        zip.on('error', reject);
        zip.readEntry();
      });
    });

    expect(names.sort()).toEqual([
      'IMS_COMPLETION_PATH.csv',
      'IMS_COMPLETION_PATH_TO_TASK.csv',
      'IMS_STEP_FAILURE.csv',
      'IMS_TASK.csv',
      'IMS_TASK_RECORD.csv',
      'IMS_TASK_TO_PARENT.csv'
    ]);
  });

  it('xlsx: returns workbook with 6 IMS_* sheets', async () => {
    const { status, data } = await project.get(
      '/admin/exports/exportLegacyData?format=xlsx',
      { ...adminAuth, responseType: 'arraybuffer' }
    );
    expect(status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(data));

    expect(wb.worksheets.map((w) => w.name).sort()).toEqual([
      'IMS_COMPLETION_PATH',
      'IMS_COMPLETION_PATH_TO_TASK',
      'IMS_STEP_FAILURE',
      'IMS_TASK',
      'IMS_TASK_RECORD',
      'IMS_TASK_TO_PARENT'
    ]);
  });

  it('rejects anonymous with 401/403', async () => {
    const { status } = await project.get(
      '/admin/exports/exportLegacyData?format=csv',
      { validateStatus: () => true }
    );
    expect([401, 403]).toContain(status);
  });

  it('rejects invalid format with 400', async () => {
    const { status } = await project.get(
      '/admin/exports/exportLegacyData?format=json',
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(400);
  });
});
