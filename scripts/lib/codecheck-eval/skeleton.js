// Pure helpers for generate-codecheck-eval-skeleton.cjs.
// No I/O, no cds, no fs — kept pure so unit tests can import directly.

const PASS_HINTS = [
  'a correct, idiomatic solution',
  'a correct but more verbose solution',
  'a correct solution in a different style',
  'a correct solution that uses the imports the author shows in the step',
  'a correct solution with different variable naming',
  'a correct solution with explanatory comments',
  'a correct solution using an early-return variant',
  'a correct solution using destructuring or modern syntax',
  'a minimal correct solution (smallest passing form)',
  'a near-copy of the author reference solution',
];

const PARTIAL_HINTS = [
  'a near-miss missing an `await`',
  'an off-by-one error',
  'wrong error handling but right happy-path logic',
  'right happy-path logic but missing an obvious edge case',
  'a harmless syntax issue but logic is right',
  'uses a deprecated-but-correct API',
  'missing input validation',
  'correct but uses confusingly wrong naming',
  'right shape but wrong helper function chosen',
  'correct logic surrounded by extraneous unrelated code',
];

const FAIL_HINTS = [
  'an off-topic poem or non-code English text',
  'an empty string',
  'gibberish characters',
  'a submission in the wrong language (e.g. Python when JS is expected)',
  'opposite logic — does the inverse of the goal',
  'a copy of the prompt or task description instead of code',
  'correct code but for a different step in the same tutorial',
  'a SQL-injection-shaped payload (must not pass)',
  'placeholder TODO comments only',
  'literal `null` or undefined-ish nonsense',
];

export function buildHintTable() {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 1).padStart(3, '0')}`, expectedVerdict: 'pass', code: '', _hint: PASS_HINTS[i] });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 11).padStart(3, '0')}`, expectedVerdict: 'partial', code: '', _hint: PARTIAL_HINTS[i] });
  }
  for (let i = 0; i < 10; i++) {
    rows.push({ id: `s${String(i + 21).padStart(3, '0')}`, expectedVerdict: 'fail', code: '', _hint: FAIL_HINTS[i] });
  }
  return rows;
}

export function formatJsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}
