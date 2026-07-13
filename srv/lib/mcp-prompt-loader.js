// srv/lib/mcp-prompt-loader.js
import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';

// NOTE: js-yaml 5.x `load()` uses DEFAULT_SCHEMA (no code execution) and is
// safe for these trusted, in-repo prompt files — the Python `yaml.load` RCE
// warning does not apply to js-yaml 5.x. Do not swap to a custom loader.
const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Load and validate all prompt .md files in `dir`. Throws on malformed frontmatter. */
export function loadPrompts(dir) {
  const map = new Map();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const norm = raw.replace(/\r\n/g, '\n');
    const m = FM_RE.exec(norm);
    if (!m) throw new Error(`mcp-prompt-loader: ${file} missing YAML frontmatter`);
    let fm;
    try { fm = yamlLoad(m[1]); } catch (e) { throw new Error(`mcp-prompt-loader: ${file} bad YAML — ${e.message}`); }
    if (!fm?.name || !fm?.description) throw new Error(`mcp-prompt-loader: ${file} needs name+description`);
    map.set(fm.name, {
      name: fm.name,
      description: fm.description,
      arguments: Array.isArray(fm.arguments) ? fm.arguments : [],
      template: m[2].trim(),
    });
  }
  return map;
}

/** prompts/list payload. */
export function listPrompts(promptMap) {
  return [...promptMap.values()].map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }));
}

/** prompts/get payload. Throws on unknown name or missing required arg. */
export function getPrompt(promptMap, name, args = {}) {
  const p = promptMap.get(name);
  if (!p) throw new Error(`unknown prompt: ${name}`);
  for (const a of p.arguments) {
    if (a.required && (args[a.name] === undefined || args[a.name] === '')) {
      throw new Error(`missing required argument: ${a.name}`);
    }
  }
  const text = p.template.replace(/\{\{(\w+)\}\}/g, (_, k) => (args[k] ?? ''));
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
