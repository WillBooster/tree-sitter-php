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
    echo match (1) { default, => ReAdOnLy /* gap */ (), };
    foo(readonly: 1);
    new Foo(readonly: true);
    #[Attr(readonly: true)] class B {}
    $x = readonly\\foo();
    const X = readonly\\Y;
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
      ).toBe('ReAdOnLy /* gap */ ()');
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s preserves operand expressions and rejects a lone match comma', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const [source, expression, field, operand] of [
      ['(int)$x = 1', 'cast_expression', 'value', 'assignment_expression'],
      ['(int)$x += 1', 'cast_expression', 'value', 'augmented_assignment_expression'],
      ['(int)$x =& $y', 'cast_expression', 'value', 'reference_assignment_expression'],
      ['clone $x = $y', 'clone_expression', undefined, 'assignment_expression'],
      ['clone $x =& referencedValue()', 'clone_expression', undefined, 'reference_assignment_expression'],
      ['clone $x =& $reader->list(default: 1)', 'clone_expression', undefined, 'reference_assignment_expression'],
      ['(int)$x =& reader(list: 1)', 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`(int)$x =& list\value()`, 'cast_expression', 'value', 'reference_assignment_expression'],
      ['C::{"VALUE"}', 'class_constant_access_expression', 'name_expression', 'encapsed_string'],
      ['C::{getName() . $tail}', 'class_constant_access_expression', 'name_expression', 'binary_expression'],
    ] as const) {
      const tree = parser.parse(`<?php ${source};`)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const outer = tree.rootNode.descendantsOfType('expression_statement')[0]?.firstNamedChild;
        expect(outer?.type, source).toBe(expression);
        expect((field ? outer?.childForFieldName(field) : outer?.firstNamedChild)?.type, source).toBe(operand);
      } finally {
        tree.delete();
      }
    }
    for (const [arms, invalid] of [
      ['', false],
      ['1 => 2,', false],
      [String.raw`1, default\VALUE => 2,`, false],
      [',', true],
      ['1, DeFaUlT => 2', true],
      ['default, 1 => 2', true],
    ] as const) {
      const tree = parser.parse(`<?php match (1) {${arms}};`)!;
      try {
        expect(tree.rootNode.hasError, arms).toBe(invalid);
      } finally {
        tree.delete();
      }
    }
    for (const source of ['clone $x =& 1', '$x =& new C()', '(int)$x =& ($y)', '[$x] =& $y', '$x =& LiSt($y)']) {
      const tree = parser.parse(`<?php ${source};`)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s parses simple nullsafe interpolation in string bodies', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    const tree = parser.parse(
      [
        '<?php',
        'echo "$o?->quoted!", "$o?->1", "$o?->", "$o?", "$o?->first->suffix";',
        '$text = <<<TEXT',
        '$o?->heredoc',
        'TEXT;',
        '$command = `$o?->command`;',
      ].join('\n')
    )!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('nullsafe_member_access_expression').map((node) => node.text)).toEqual([
        '$o?->quoted',
        '$o?->first',
        '$o?->heredoc',
        '$o?->command',
      ]);
      expect(tree.rootNode.descendantsOfType('string_content').map((node) => node.text)).toEqual(
        expect.arrayContaining(['?->1', '?->', '?', '->suffix'])
      );
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});
