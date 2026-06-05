// srv/lib/validate-answer-question-loader.js
// Placeholder shipped by Task 6 (#209). The real implementation arrives in
// Task 7 and will read from the ValidateAnswerSpecs HANA entity. Until then,
// the export exists so srv/server.js can wire the /api/validate-answer route
// without breaking module loading; if the route is ever hit before Task 7
// ships the real loader, the handler's dispatch will surface a clear runtime
// error instead of failing at boot.

import cds from '@sap/cds';

const LOG = cds.log('validate-answer-loader');

export async function defaultLoadQuestion(/* slug, stepNumber, questionId */) {
  LOG.error(
    '[STUB] defaultLoadQuestion placeholder hit — Task 7 of #209 should have replaced this file before deploy',
  );
  throw new Error(
    'defaultLoadQuestion not yet implemented — Task 7 of #209 ships the real loader',
  );
}
