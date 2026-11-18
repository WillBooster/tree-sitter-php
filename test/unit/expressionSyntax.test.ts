import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s uses PHP precedence for print and instanceof', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const [source, operator, left, argument, right] of [
      ['print 0 or print 3', 'or', 'print_intrinsic', undefined, 'print_intrinsic'],
      ['print $x = 3', undefined, undefined, undefined, undefined],
      ['-$x instanceof A', 'instanceof', 'unary_op_expression', undefined, 'name'],
      ['$x ** 2 instanceof A', 'instanceof', 'binary_expression', undefined, 'name'],
      ['!$x instanceof A', '!', undefined, 'binary_expression', undefined],
      ['$x instanceof A instanceof B', 'instanceof', 'binary_expression', undefined, 'name'],
    ]) {
      const tree = parser.parse(`<?php ${source};`)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const expression = tree.rootNode.descendantsOfType('expression_statement')[0]?.firstNamedChild as Node;
        expect(
          [
            expression.childForFieldName('operator')?.text,
            expression.childForFieldName('left')?.type,
            expression.childForFieldName('argument')?.type,
            expression.childForFieldName('right')?.type,
          ],
          source
        ).toEqual([operator, left, argument, right]);
        if (source === 'print $x = 3') expect(expression.firstNamedChild?.type).toBe('assignment_expression');
        if (source === '$x instanceof A instanceof B') {
          expect(expression.childForFieldName('left')?.childForFieldName('operator')?.text).toBe('instanceof');
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s accepts switch, match, and readonly function syntax', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  const source = `<?php
    function readonly() { return 2; }
    readonly class Immutable {}
    switch (1) { ; }
    switch (1): ; case 1: break; endswitch;
    echo match (1) { default, => ReAdOnLy(), };
  `;
  try {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('function_definition')[0]?.childForFieldName('name')?.text).toBe(
        'readonly'
      );
      expect(tree.rootNode.descendantsOfType('switch_statement')).toHaveLength(2);
      expect(
        tree.rootNode.descendantsOfType('match_default_expression')[0]?.childForFieldName('return_expression')?.text
      ).toBe('ReAdOnLy()');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});
