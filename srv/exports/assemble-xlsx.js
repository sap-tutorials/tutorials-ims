import ExcelJS from 'exceljs';

import * as tasks from './tasks.js';
import * as taskRecords from './task-records.js';
import * as taskToParent from './task-to-parent.js';
import * as completionPath from './completion-path.js';
import * as completionPathToTask from './completion-path-to-task.js';
import * as stepFailures from './step-failures.js';

const SHEETS = [
  ['IMS_TASK',                     tasks],
  ['IMS_TASK_RECORD',              taskRecords],
  ['IMS_TASK_TO_PARENT',           taskToParent],
  ['IMS_COMPLETION_PATH',          completionPath],
  ['IMS_COMPLETION_PATH_TO_TASK',  completionPathToTask],
  ['IMS_STEP_FAILURE',             stepFailures]
];

export async function assembleXlsx(db, outStream, opts = {}) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outStream, useStyles: false });
  for (const [name, mod] of SHEETS) {
    const ws = wb.addWorksheet(name);
    ws.addRow(mod.legacyHeader).commit();
    for await (const row of mod.rows(db, opts)) {
      ws.addRow(row).commit();
    }
    ws.commit();
  }
  await wb.commit();
}
