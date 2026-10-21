import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { extractVersion } from '../src/version-tag.ts';

/**
 * Machine-readable gallery index, published as `/demos.json` next to the site so other places that
 * list the gallery (the img2threejs README) follow it instead of keeping a second, hand-edited list.
 *
 * Read from the same `authored` literal the gallery renders, by syntax rather than by import:
 * registry.ts reads `import.meta.env` at module scope, which only exists under Vite.
 * `version` uses the gallery's own extractVersion, so the README and the version badge agree.
 * Run with `node --import tsx` (it imports TypeScript).
 */
export const SITE = 'https://img2threejs.io';
export const REPO = 'https://github.com/img2threejs/img2threejs-showcase/blob/main';
const FIELDS = ['id', 'title', 'subjectClass', 'status', 'generatedWith', 'updatedAt', 'sourcePath'];

/** A string literal, or literals joined with `+` (long values are wrapped that way); otherwise null. */
function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

export function demosFromRegistry(source) {
  const file = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(file) === 'authored'));
  const array = declaration?.declarationList.declarations[0].initializer;
  if (!array || !ts.isArrayLiteralExpression(array)) throw new Error('Showcase catalog `authored` must be a literal array.');
  const demos = array.elements.map((entry) => {
    if (!ts.isObjectLiteralExpression(entry)) throw new Error('Showcase entries must be object literals.');
    const demo = {};
    for (const field of FIELDS) {
      const value = entry.properties.find((property) => property.name?.getText(file) === field)?.initializer;
      const text = value ? literalText(value) : null;
      if (text === null) throw new Error(`Showcase ${demo.id ?? '(unknown)'}: \`${field}\` must be a string literal.`);
      demo[field] = text;
    }
    return {
      ...demo,
      version: extractVersion(demo.generatedWith),
      url: `${SITE}/#/demo/${demo.id}`,
      sourceUrl: `${REPO}/${demo.sourcePath}`,
    };
  });
  // Same order as the gallery: newest first, stable for equal dates.
  return demos.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function writeDemosJson(root, out) {
  const source = await readFile(path.join(root, 'src/demos/registry.ts'), 'utf8');
  const demos = demosFromRegistry(source);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ schema: 1, site: SITE, demos }, null, 2) + '\n');
  return demos;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(root, process.argv[2] ?? 'dist/demos.json');
  const demos = await writeDemosJson(root, out);
  console.log(`demos.json: ${demos.length} demos -> ${path.relative(root, out)}`);
}
