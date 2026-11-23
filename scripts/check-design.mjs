import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const web = resolve('src/web');

/** Shared design-system parts whose classes may only be targeted from their owning stylesheet.
 * Reading descendant state via `:has(...)` on a parent container is allowed; restyling the part's
 * own box or internals from another stylesheet is rejected. */
const OWNED_PARTS = [
  {
    name: 'Composer',
    owner: 'styles/composer.css',
    classes: [
      'ui-compose-wrap',
      'ui-composer',
      'jv-composer',
      'jv-composer-extra',
      'jv-compose-quote',
      'jv-compose-quotes',
      'jarvy-attach-trigger',
      'jarvy-pending-files',
      'jarvy-file-chip',
      'jarvy-file-progress',
      'jarvy-dropping',
      'jarvy-drop-hint',
    ],
    hint: 'Add or select a `place` variant on <Composer> (src/web/composer/Composer.tsx) and style it in src/web/styles/composer.css.',
  },
];

const COMPOSER_BASELINE_PROPS = new Set(['padding', 'padding-bottom', 'padding-block', 'padding-block-end']);

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? cssFiles(resolve(dir, item.name)) : item.name.endsWith('.css') ? [resolve(dir, item.name)] : [],
  );
}

/** Replace block comments with spaces/newlines of identical line count so reported line numbers stay exact. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

/** Remove `:has(...)` segments (handling nested parens) so parent state checks do not count as styling the part. */
function stripHas(selector) {
  let out = '';
  for (let i = 0; i < selector.length; ) {
    if (selector.startsWith(':has(', i)) {
      let depth = 1;
      i += 5;
      while (i < selector.length && depth > 0) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')') depth--;
        i++;
      }
      continue;
    }
    out += selector[i++];
  }
  return out;
}

/** Split a selector list on top-level commas (outside `(...)` and `[...]`). */
function splitSelectors(prelude) {
  const list = [];
  let start = 0, paren = 0, bracket = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === ',' && paren === 0 && bracket === 0) {
      list.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  }
  list.push(prelude.slice(start).trim());
  return list.filter(Boolean);
}

/** Walk a CSS stylesheet (including nested `@media` / `@layer` / `@supports` blocks) and collect style rules. */
function parseStyleRules(raw) {
  const text = stripComments(raw);
  const rules = [];
  const lineAt = index => text.slice(0, index).split('\n').length;
  function walk(start, end) {
    let cursor = start;
    while (cursor < end) {
      while (cursor < end && /\s/.test(text[cursor])) cursor++;
      if (cursor >= end) break;
      const ruleStart = cursor;
      let brace = -1, semi = -1, inStr = '';
      for (let i = cursor; i < end; i++) {
        const ch = text[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === inStr) inStr = '';
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') { brace = i; break; }
        if (ch === ';') { semi = i; break; }
      }
      if (semi !== -1 && (brace === -1 || semi < brace)) { cursor = semi + 1; continue; }
      if (brace === -1) break;
      let depth = 1, close = brace + 1;
      inStr = '';
      while (close < end && depth > 0) {
        const ch = text[close];
        if (inStr) {
          if (ch === '\\') { close += 2; continue; }
          if (ch === inStr) inStr = '';
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
        close++;
      }
      const prelude = text.slice(ruleStart, brace).trim();
      const bodyStart = brace + 1, bodyEnd = close - 1;
      if (prelude.startsWith('@')) {
        if (/^@(media|layer|supports|container|scope)\b/i.test(prelude)) walk(bodyStart, bodyEnd);
      } else if (prelude) {
        rules.push({ prelude, selectors: splitSelectors(prelude), body: text.slice(bodyStart, bodyEnd), line: lineAt(ruleStart) });
      }
      cursor = close;
    }
  }
  walk(0, text.length);
  return rules;
}

function parseProperties(body) {
  const props = [];
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (prop) props.push(prop);
  }
  return props;
}

const failures = [];
const partPatterns = OWNED_PARTS.map(part => ({
  ...part,
  regex: new RegExp(`\\.(${part.classes.join('|')})(?![A-Za-z0-9_-])`),
}));

for (const file of cssFiles(web)) {
  const rel = relative(web, file).replaceAll('\\', '/');
  const rules = parseStyleRules(readFileSync(file, 'utf8'));
  for (const rule of rules) {
    // 1. Shared part CSS ownership: external stylesheets may not restyle owned part classes.
    for (const part of partPatterns) {
      if (rel === part.owner) continue;
      for (const selector of rule.selectors) {
        const match = part.regex.exec(stripHas(selector));
        if (match) {
          failures.push(
            `${rel}:${rule.line}: selector "${selector}" targets ${part.name} class ".${match[1]}" outside ${part.owner}.\n  → ${part.hint}`,
          );
          break;
        }
      }
    }
    // 2. Composer bottom-baseline invariant: non-dock [data-place] variants may only adjust horizontal insets.
    if (rel === 'styles/composer.css') {
      const nonDockPlace = rule.selectors.filter(
        sel => /\.ui-compose-wrap\b/.test(sel) && /\[data-place=(?:"|')?(?!dock\b)[a-z0-9_-]+(?:"|')?\]/i.test(sel),
      );
      if (nonDockPlace.length) {
        for (const prop of parseProperties(rule.body)) {
          if (COMPOSER_BASELINE_PROPS.has(prop)) {
            failures.push(
              `${rel}:${rule.line}: "${nonDockPlace.join(', ')}" sets "${prop}".\n  → Non-dock [data-place] variants must only adjust horizontal inset (padding-inline / padding-left / padding-right) so side-by-side composers share one bottom baseline.`,
            );
          }
        }
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log('Design boundaries: OK');
}
