import { ZipArchive } from 'archiver';
import { stringify as csvStringify } from 'csv-stringify';
import { PassThrough } from 'node:stream';

import * as tasks from './tasks.js';
import * as taskRecords from './task-records.js';
import * as taskToParent from './task-to-parent.js';
import * as completionPath from './completion-path.js';
import * as completionPathToTask from './completion-path-to-task.js';
import * as stepFailures from './step-failures.js';

const FILES = [
  ['IMS_TASK.csv',                     tasks],
  ['IMS_TASK_RECORD.csv',              taskRecords],
  ['IMS_TASK_TO_PARENT.csv',           taskToParent],
  ['IMS_COMPLETION_PATH.csv',          completionPath],
  ['IMS_COMPLETION_PATH_TO_TASK.csv',  completionPathToTask],
  ['IMS_STEP_FAILURE.csv',             stepFailures]
];

export async function assembleCsvZip(db, outStream, opts = {}) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(outStream);

  for (const [name, mod] of FILES) {
    const pass = new PassThrough();
    archive.append(pass, { name });

    const stringifier = csvStringify({ header: true, columns: mod.legacyHeader });
    stringifier.pipe(pass);

    for await (const row of mod.rows(db, opts)) {
      if (!stringifier.write(row)) {
        await new Promise(res => stringifier.once('drain', res));
      }
    }
    stringifier.end();
    // wait for pass to drain before archiver moves to the next entry
    await new Promise((res, rej) => { pass.on('end', res); pass.on('error', rej); });
  }

  await archive.finalize();
}
