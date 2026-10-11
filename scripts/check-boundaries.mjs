import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve('src/server');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name)) : item.name.endsWith('.ts') ? [resolve(dir, item.name)] : []);
}
const failures = [];
for (const file of files(root)) {
  const text = readFileSync(file, 'utf8');
  const layer = relative(root, file).split('/')[0];
  if (text.split('\n').length > 501) failures.push(`${relative(root, file)}: exceeds 500 lines`);
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
