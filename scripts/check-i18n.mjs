// Interface languages (A45): the English reference and every other dictionary must cover the same keys with the same
// placeholders, no translation may be empty, and no component may carry its own Chinese text. A dictionary is a folder
// of parts put together in its index.ts: every language has the same parts, and a key lives in one part only. The server names
// failures with codes and the web words them (web/errors.ts): the two lists must match.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const web = resolve('src/web'), i18n = resolve(web, 'i18n');
const failures = [];
const read = file => readFileSync(file, 'utf8');

/** A dictionary folder's parts (all but index.ts), as key → source text and where it is. */
function dictionary(name) {
  const dir = resolve(i18n, name), parts = readdirSync(dir).filter(file => file.endsWith('.ts') && file !== 'index.ts').sort();
  const entries = new Map();
  for (const part of parts) {
    const file = resolve(dir, part);
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const walk = node => {
      if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
        const value = property.initializer, key = property.name.text;
        const literal = ts.isStringLiteral(value) ? value.text : null;
        const plural = ts.isObjectLiteralExpression(value) ? Object.fromEntries(value.properties.filter(item => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name)).map(item => [item.name.text, ts.isStringLiteral(item.initializer) ? item.initializer.text : null])) : null;
        const where = `${relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(value.getStart(source)).line + 1}`;
        if (entries.has(key)) failures.push(`${where}: "${key}" is already in ${entries.get(key).where} — a key lives in one part`);
        entries.set(key, { literal, plural, where });
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { name, parts, entries };
}

const variables = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');
const reference = dictionary('en');
const others = readdirSync(i18n, { withFileTypes: true }).filter(item => item.isDirectory() && item.name !== 'en').map(item => dictionary(item.name));
if (!others.length) failures.push('i18n: no dictionary beside en/');

for (const { name, parts, entries } of others) {
  if (parts.join() !== reference.parts.join()) failures.push(`i18n/${name}: parts ${parts.join(', ')} — en has ${reference.parts.join(', ')}`);
  for (const [key, entry] of reference.entries) {
    const other = entries.get(key);
    if (!other) { failures.push(`i18n/${name}: missing "${key}" (en: ${entry.where})`); continue; }
    if (other.literal !== null || entry.literal !== null) {
      if (entry.literal === null || other.literal === null) { failures.push(`${other.where}: "${key}" must ${entry.literal === null ? 'have' : 'drop'} its plural forms`); continue; }
      if (!other.literal.trim()) failures.push(`${other.where}: "${key}" is empty`);
      if (variables(entry.literal) !== variables(other.literal)) failures.push(`${other.where}: "${key}" differs in placeholders (${variables(entry.literal)} vs ${variables(other.literal)})`);
    } else {
      for (const form of ['one', 'other']) {
        const mine = entry.plural?.[form] ?? null, their = other.plural?.[form] ?? null;
        if (mine === null || their === null) { failures.push(`${other.where}: "${key}.${form}" must ${mine === null ? 'be a string' : 'exist'}`); continue; }
        if (!their.trim()) failures.push(`${other.where}: "${key}.${form}" is empty`);
        if (variables(mine) !== variables(their)) failures.push(`${other.where}: "${key}.${form}" differs in placeholders`);
      }
    }
  }
  for (const [key, entry] of entries) if (!reference.entries.has(key)) failures.push(`${entry.where}: "${key}" is not in en/`);
}

/** Every UI file, minus the dictionaries themselves. */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name)) : /\.tsx?$/.test(item.name) ? [resolve(dir, item.name)] : []);
}
const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** Chinese in a string, template or JSX text — comments and the dictionaries are the only places it belongs. */
function chinese(file) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const found = [];
  const check = (node, text) => { if (cjk.test(text)) found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1); };
  const walk = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(""));
    else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

for (const file of files(web)) {
  const name = relative(web, file);
  // In i18n/ only the module and the key types are code; the rest are dictionaries. And the vendored shadcn copies
  // are translated where they are used, not wholesale.
  if (name.startsWith('i18n/') && name !== 'i18n/index.tsx' && name !== 'i18n/keys.ts' || name.startsWith('components/')) continue;
  const lines = chinese(file);
  for (const line of lines) failures.push(`${name}:${line}: Chinese text — use t()`);
}

/** Failure codes (A45): the server's coded throws against the table in web/errors.ts. */
const CODE_ARGUMENT = { RuntimeFault: 0, ChatError: 2, ValidationError: 1, ConflictError: 1 };
const thrown = new Map();
for (const file of files(resolve('src/server'))) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const walk = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in CODE_ARGUMENT) {
      const code = node.arguments?.[CODE_ARGUMENT[node.expression.text]];
      if (code && ts.isStringLiteralLike(code) && !thrown.has(code.text)) thrown.set(code.text, `${relative(resolve('src'), file)}:${source.getLineAndCharacterOfPosition(code.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
}
const errorsFile = resolve(web, 'errors.ts'), worded = new Set();
const findTable = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText() === 'ERROR_KEYS' && node.initializer && ts.isObjectLiteralExpression(node.initializer))
    for (const property of node.initializer.properties) if (property.name) worded.add(property.name.getText().replace(/^['"]|['"]$/g, ''));
  ts.forEachChild(node, findTable);
};
findTable(ts.createSourceFile(errorsFile, read(errorsFile), ts.ScriptTarget.Latest, true));
if (!worded.size) failures.push('web/errors.ts: no ERROR_KEYS table found');
for (const [code, place] of thrown) if (!worded.has(code)) failures.push(`${place}: failure code "${code}" has no wording in web/errors.ts`);
for (const code of worded) if (!thrown.has(code)) failures.push(`web/errors.ts: "${code}" is no longer thrown by the server — remove it`);

if (failures.length) { console.error(`i18n:\n${failures.join('\n')}`); process.exitCode = 1; }
else console.log('i18n: OK');
