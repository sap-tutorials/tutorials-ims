import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'hugo/static/js/vendor');
await mkdir(target, { recursive: true });

const files = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  ['node_modules/dompurify/dist/purify.min.js',         'purify.min.js']
];

try {
  for (const [src, name] of files) {
    await copyFile(resolve(root, src), resolve(target, name));
    console.log(`copied ${name}`);
  }
} catch (err) {
  console.error(`copy-joule-vendor failed: ${err.message}`);
  process.exit(1);
}
