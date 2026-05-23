import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import yauzl from 'yauzl';

cds.test('serve', '--project', '.', '--in-memory');

describe('assemble-csv-zip', () => {
  let assemble;
  beforeAll(async () => {
    assemble = (await import('../../../srv/exports/assemble-csv-zip.js')).assembleCsvZip;
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    for (const name of ['Tutorials','Missions','Groups','Steps','Checkpoints',
                        'TaskRecords','StepFailures','CompletionPaths','CompletionPathItems',
                        'GroupPathItems','Users']) {
      await db.run(DELETE.from(cds.entities('com.sap.developers.ims')[name]));
    }
  });

  it('produces a ZIP with 6 entries, each named IMS_*.csv', async () => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', c => chunks.push(c));
    const finished = new Promise(res => sink.on('end', res));

    const db = await cds.connect.to('db');
    await assemble(db, sink);
    await finished;
    const buf = Buffer.concat(chunks);

    const entries = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        const names = [];
        zipfile.on('entry', e => { names.push(e.fileName); zipfile.readEntry(); });
        zipfile.on('end', () => resolve(names));
        zipfile.readEntry();
      });
    });

    expect(entries.sort()).toEqual([
      'IMS_COMPLETION_PATH.csv',
      'IMS_COMPLETION_PATH_TO_TASK.csv',
      'IMS_STEP_FAILURE.csv',
      'IMS_TASK.csv',
      'IMS_TASK_RECORD.csv',
      'IMS_TASK_TO_PARENT.csv'
    ]);
  });
});
