import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import ExcelJS from 'exceljs';

cds.test('serve', '--project', '.', '--in-memory');

describe('assemble-xlsx', () => {
  let assemble;
  beforeAll(async () => {
    assemble = (await import('../../../srv/exports/assemble-xlsx.js')).assembleXlsx;
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    for (const name of ['Tutorials','Missions','Groups','Steps','Checkpoints',
                        'TaskRecords','StepFailures','CompletionPaths','CompletionPathItems',
                        'GroupPathItems','Users']) {
      await db.run(DELETE.from(cds.entities('com.sap.developers.ims')[name]));
    }
  });

  it('produces a workbook with 6 sheets, legacy names, header rows', async () => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', c => chunks.push(c));

    const db = await cds.connect.to('db');
    await assemble(db, sink);
    const buf = Buffer.concat(chunks);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheetNames = wb.worksheets.map(ws => ws.name).sort();
    expect(sheetNames).toEqual([
      'IMS_COMPLETION_PATH',
      'IMS_COMPLETION_PATH_TO_TASK',
      'IMS_STEP_FAILURE',
      'IMS_TASK',
      'IMS_TASK_RECORD',
      'IMS_TASK_TO_PARENT'
    ]);

    const taskSheet = wb.getWorksheet('IMS_TASK');
    expect(taskSheet.getRow(1).values.slice(1)).toEqual([
      'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
      'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
      'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });
});
