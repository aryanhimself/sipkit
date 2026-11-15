// @vitest-environment node
/**
 * Guard: user-visible text in the widget must come from the message catalogue.
 * Flags JSX text and string literals in text-bearing props (aria-label, title,
 * placeholder, label, description, …) that contain letters. Symbols and
 * digits ('#', '*', '✓', '—', '0') are fine.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const TEXT_PROPS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'description',
  'submitLabel',
]);

/** Literals that are not prose: example values, the brand monogram fallback. */
const ALLOWED = new Set(['wss://pbx.example.com:8089/ws', 'pbx.example.com', 'E']);

const HAS_LETTER = /\p{L}/u;

function files(): string[] {
  const out: string[] = [join(SRC, 'softphone.tsx')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
    }
  };
  walk(join(SRC, 'features'));
  walk(join(SRC, 'components', 'ui'));
  return out;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return null;
}

/** String literals reachable as the *value* of an expression (ternaries, ||, ??). */
function valueLiterals(expr: ts.Expression): string[] {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  const text = literalText(e);
  if (text !== null) return [text];
  if (ts.isConditionalExpression(e)) return [...valueLiterals(e.whenTrue), ...valueLiterals(e.whenFalse)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind))
    return valueLiterals(e.right);
  return [];
}

export function findHardcodedStrings(source: string, fileName = 'file.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const t = text.trim();
    if (!t || !HAS_LETTER.test(t) || ALLOWED.has(t)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${fileName}:${line + 1}: ${JSON.stringify(t)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      for (const text of valueLiterals(node.expression)) report(node, text);
    } else if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression)
        for (const text of valueLiterals(init.expression)) report(init, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

describe('no hard-coded UI strings', () => {
  it('detects JSX text and text props (self-test)', () => {
    const sample = `
      const a = <button aria-label="Hang up" title={x ? 'On' : "Off"}>Call <b>{'now'}</b></button>;
      const b = <span aria-label={t('ok')} data-key="#">#{n} * 0 ✓ —</span>;
      const c = <Input placeholder={\`Search \${q}\`} className="pl-8" />;
    `;
    expect(findHardcodedStrings(sample).map((p) => p.split(': ')[1])).toEqual([
      '"Hang up"',
      '"On"',
      '"Off"',
      '"Call"',
      '"now"',
      '"Search"',
    ]);
  });

  it('packages/ui widget sources use the message catalogue', () => {
    const problems = files().flatMap((f) => findHardcodedStrings(readFileSync(f, 'utf8'), relative(SRC, f)));
    expect(problems, `Externalise these strings into src/i18n/en.ts:\n${problems.join('\n')}`).toEqual([]);
  });
});
