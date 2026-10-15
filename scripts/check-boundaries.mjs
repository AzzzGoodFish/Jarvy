import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve('src/server');
function files(dir, pattern = /\.ts$/) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(resolve(dir, item.name), pattern) : pattern.test(item.name) ? [resolve(dir, item.name)] : []);
}
const failures = [];
// Execution in work environments (A50): pi-env and the Pi Durable pieces it is built on stay in infra/env.
const EXECUTION = /^@earendil-works\/(pi-env|pi-durable|chord)(\/|$)/;
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
      || EXECUTION.test(specifier) && !relative(root, file).startsWith('infra/env/')
      || specifier.startsWith('@earendil-works/') && !EXECUTION.test(specifier) && !relative(root, file).startsWith('infra/pi/')
      || specifier === 'node:sqlite' && !relative(root, file).startsWith('infra/storage/');
    if (forbidden) failures.push(`${relative(root, file)} → ${specifier}`);
  }
}
// The web is a client of the HTTP API: src/web never imports src/server, statically, as a type or with import().
const web = resolve('src/web');
for (const file of files(web, /\.tsx?$/)) {
  const syntax = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.') && !relative(root, resolve(dirname(file), specifier.text)).startsWith('..'))
      failures.push(`${relative(resolve('src'), file)} → ${specifier.text} (src/web never imports src/server)`);
    ts.forEachChild(node, visit);
  };
  visit(syntax);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries: OK');
