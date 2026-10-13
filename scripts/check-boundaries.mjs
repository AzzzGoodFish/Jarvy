import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve('src/server');
function files(dir, pattern = /\.ts$/) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name), pattern) : pattern.test(item.name) ? [resolve(dir, item.name)] : []);
}
const failures = [];
// No source file over 500 lines (AGENTS.md), server and web alike.
for (const file of [...files(root), ...files(resolve('src/web'), /\.(tsx?|css)$/)]) {
  if (readFileSync(file, 'utf8').split('\n').length > 501) failures.push(`${relative(resolve('src'), file)}: exceeds 500 lines`);
}
for (const file of files(root)) {
  const text = readFileSync(file, 'utf8');
  const layer = relative(root, file).split('/')[0];
  const syntax = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const node of syntax.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const specifier = node.moduleSpecifier.text;
    const target = specifier.startsWith('.') ? relative(root, resolve(dirname(file), specifier)).split('/')[0] : null;
    const forbidden = layer === 'api' && target === 'infra'
      || layer === 'service' && target === 'api'
      || layer === 'infra' && ['api', 'service', 'application.js'].includes(target)
      || layer === 'shared' && target !== null && target !== 'shared'
      || specifier.startsWith('@earendil-works/') && !relative(root, file).startsWith('infra/pi/')
      || specifier === 'node:sqlite' && !relative(root, file).startsWith('infra/storage/');
    if (forbidden) failures.push(`${relative(root, file)} → ${specifier}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries: OK');
