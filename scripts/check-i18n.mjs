// Interface languages (A45): the English reference and every other dictionary must cover the same keys with the same
// placeholders, no translation may be empty, and no component may carry its own Chinese text. Files not migrated yet
// are listed in PENDING; a file there that is already clean is an error too, so the list can only shrink.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const web = resolve('src/web'), i18n = resolve(web, 'i18n');
const failures = [];
const read = file => readFileSync(file, 'utf8');

/** The reference and the other dictionaries, as key → source text. */
function dictionary(name) {
  const file = resolve(i18n, `${name}.ts`);
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const entries = new Map();
  const walk = node => {
    if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
      const value = property.initializer;
      const literal = ts.isStringLiteral(value) ? value.text : null;
      const plural = ts.isObjectLiteralExpression(value) ? Object.fromEntries(value.properties.filter(item => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name)).map(item => [item.name.text, ts.isStringLiteral(item.initializer) ? item.initializer.text : null])) : null;
      const start = value.getStart(source);
      entries.set(property.name.text, { literal, plural, line: source.getLineAndCharacterOfPosition(start).line + 1 });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { file, entries };
}

const variables = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');
const reference = dictionary('en');
const others = readdirSync(i18n).filter(name => name.endsWith('.ts') && name !== 'en.ts' && name !== 'keys.ts').map(name => dictionary(name.replace(/\.ts$/, '')));
if (!others.length) failures.push('i18n: no dictionary beside en.ts');

for (const { file, entries } of others) {
  const name = relative(process.cwd(), file);
  for (const [key, entry] of reference.entries) {
    const other = entries.get(key);
    if (!other) { failures.push(`${name}: missing "${key}"`); continue; }
    if (other.literal !== null || entry.literal !== null) {
      if (entry.literal === null || other.literal === null) { failures.push(`${name}: "${key}" must ${entry.literal === null ? 'have' : 'drop'} its plural forms`); continue; }
      if (!other.literal.trim()) failures.push(`${name}: "${key}" is empty`);
      if (variables(entry.literal) !== variables(other.literal)) failures.push(`${name}: "${key}" differs in placeholders (${variables(entry.literal)} vs ${variables(other.literal)})`);
    } else {
      for (const form of ['one', 'other']) {
        const mine = entry.plural?.[form] ?? null, their = other.plural?.[form] ?? null;
        if (mine === null || their === null) { failures.push(`${name}: "${key}.${form}" must ${mine === null ? 'be a string' : 'exist'}`); continue; }
        if (!their.trim()) failures.push(`${name}: "${key}.${form}" is empty`);
        if (variables(mine) !== variables(their)) failures.push(`${name}: "${key}.${form}" differs in placeholders`);
      }
    }
  }
  for (const key of entries.keys()) if (!reference.entries.has(key)) failures.push(`${name}: "${key}" is not in en.ts`);
}

/** Every UI file, minus the dictionaries themselves. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name)) : /\.tsx?$/.test(item.name) ? [resolve(dir, item.name)] : []);
}
const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** Chinese in a string, template or JSX text — comments and zh.ts are the only places it belongs. */
function chinese(file) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const found = [];
  const check = (node, text) => { if (cjk.test(text)) found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1); };
  const walk = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, node.head.text);
    else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const PENDING = new Set([
  'HistoryDetail.tsx', 'activity/ActivityDetail.tsx', 'activity/ActivityTimeline.tsx', 'activity/BotActivity.tsx', 'api.ts', 'avatar/BotAvatar.tsx',
  'avatar/FloatingBot.tsx', 'avatar/palette.ts',
]);
const seen = new Set();
for (const file of files(web)) {
  const name = relative(web, file);
  // In i18n/ only the module and the key types are code; the rest are dictionaries. And the vendored shadcn copies
  // are translated where they are used, not wholesale.
  if (name.startsWith('i18n/') && name !== 'i18n/index.tsx' && name !== 'i18n/keys.ts' || name.startsWith('components/')) continue;
  const lines = chinese(file);
  if (PENDING.has(name)) { seen.add(name); if (!lines.length) failures.push(`${name}: no Chinese left — drop it from PENDING`); continue; }
  for (const line of lines) failures.push(`${name}:${line}: Chinese text — use t() (${name} is not in PENDING)`);
}
for (const name of PENDING) if (!seen.has(name)) failures.push(`PENDING lists ${name}, which is not a file in src/web`);

if (failures.length) { console.error(`i18n:\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log('i18n: OK');
