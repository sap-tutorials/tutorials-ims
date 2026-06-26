// Cross-platform Hugo simulator. Mode chosen via HUGO_STUB_MODE env var.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.HUGO_STUB_MODE ?? 'ok';
const argMap = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--') && arr[i + 1] && !arr[i + 1].startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

if (mode === 'fail') {
  process.stderr.write('ERROR rendering: synthetic stub failure\n');
  process.exit(1);
}
if (mode === 'xss') {
  process.stderr.write('ERROR: <script>alert("x")</script> & friends\n');
  process.exit(1);
}
if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60_000);
} else {
  const dest = argMap.destination;
  const out = join(dest, 'tutorials', '__preview__');
  mkdirSync(out, { recursive: true });
  // [#655] When mode === 'echo', include the source frontmatter in the body so
  // tests can assert validation/codecheck/rulesVrSource threading without
  // requiring a real Hugo binary. The source markdown is read from --contentDir.
  let body = 'preview-ok';
  if (mode === 'echo') {
    const contentDir = argMap.contentDir;
    const src = join(contentDir, 'tutorials', '__preview__', 'index.md');
    if (existsSync(src)) {
      body = `preview-ok\n<pre id="echo-src">${readFileSync(src, 'utf8').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`;
    }
  }
  writeFileSync(join(out, 'index.html'), `<!doctype html><html><head><title>Stub</title></head><body>${body}</body></html>`);
  process.exit(0);
}
