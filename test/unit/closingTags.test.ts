import path from 'node:path';

import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const Statements = [
  ['return', 'return_statement', 'return'],
  ['while (true) continue', 'continue_statement', 'continue'],
  ['while (true) break', 'break_statement', 'break'],
  ['$generator = fn() => yield', 'yield_expression', 'yield'],
] as const;
await Parser.init();

test.each(['php', 'php_only'])('%s terminates optional expressions before closing tags', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  try {
    for (const [body, type, statement] of Statements) {
      for (const trivia of [' ', '\r\n', ' // trailing\n', ' /* trailing */ ', ' # trailing\n']) {
        const source = `<?php ${body}${trivia}?>`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const statements = tree.rootNode.descendantsOfType(type);
          expect(
            statements.map((node) => [
              node.firstChild?.text,
              node.namedChildren.filter((child) => child.type !== 'comment').length,
            ]),
            source
          ).toEqual([[statement, 0]]);
          expect(
            tree.rootNode.descendantsOfType('php_end_tag').map((node) => [node.text, node.startIndex, node.endIndex])
          ).toEqual([['?>', source.length - 2, source.length]]);
          expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(
            trivia.includes('trailing') ? [trivia.trim()] : []
          );
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps statements in their PHP blocks after implicit semicolons', async () => {
  const language = await Language.load(path.resolve('tree-sitter-php.wasm'));
  const parser = new Parser().setLanguage(language);
  const source = '<?php return ?>one<?php $first=1; return // trailing\n?>two<?php $second=2;';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      tree.rootNode.descendantsOfType('return_statement').map((node) => [node.text, node.namedChildCount])
    ).toEqual([
      ['return', 0],
      ['return', 0],
    ]);
    expect(
      tree.rootNode.descendantsOfType('expression_statement').map((node) => [node.text, node.parent?.type])
    ).toEqual([
      ['$first=1;', 'program'],
      ['$second=2;', 'program'],
    ]);
    expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['one', 'two']);
    expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['// trailing']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s reparses optional return operands and undo before closing tags', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  const prefix = '<?php return ';
  let operand = String.raw`array\Target`;
  let tree = parser.parse(`${prefix}${operand} ?>`)!;
  try {
    for (const replacement of ['', String.raw`array\Target`]) {
      tree.edit(
        new Edit({
          startIndex: prefix.length,
          oldEndIndex: prefix.length + operand.length,
          newEndIndex: prefix.length + replacement.length,
          startPosition: { row: 0, column: prefix.length },
          oldEndPosition: { row: 0, column: prefix.length + operand.length },
          newEndPosition: { row: 0, column: prefix.length + replacement.length },
        })
      );
      const source = `${prefix}${replacement} ?>`;
      const incremental = parser.parse(source, tree)!;
      const fresh = parser.parse(source)!;
      try {
        expect(incremental.rootNode.hasError, source).toBe(false);
        expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(incremental.rootNode.descendantsOfType('return_statement').map((node) => node.text)).toEqual([
          replacement ? `return ${replacement}` : 'return',
        ]);
        expect(incremental.rootNode.descendantsOfType('qualified_name').map((node) => node.text)).toEqual(
          replacement ? [replacement] : []
        );
      } finally {
        fresh.delete();
      }
      tree.delete();
      tree = incremental;
      operand = replacement;
    }
  } finally {
    tree.delete();
    parser.delete();
  }
});
