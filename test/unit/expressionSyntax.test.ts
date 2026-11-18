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
      ['(string)$x =& $y ** 2', 'cast_expression', 'value', 'binary_expression'],
      ['(bool)(string)$x =& $y ** 2', 'cast_expression', 'value', 'cast_expression'],
      ['clone $x = $y', 'clone_expression', undefined, 'assignment_expression'],
      ['clone $x =& referencedValue()', 'clone_expression', undefined, 'reference_assignment_expression'],
      ['clone $x =& static::read()', 'clone_expression', undefined, 'reference_assignment_expression'],
      ['clone new static()', 'clone_expression', undefined, 'object_creation_expression'],
      ['clone $x =& $reader->list(default: 1)', 'clone_expression', undefined, 'reference_assignment_expression'],
      ['(int)$x =& reader(list: 1)', 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`(int)$x =& list\value()`, 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`(int)$x =& match\value()`, 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`(int)$x =& namespace\value()`, 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`(int)$x =& new\Library\read()`, 'cast_expression', 'value', 'reference_assignment_expression'],
      [String.raw`$x =& new\Library\read()`, 'reference_assignment_expression', undefined, 'variable_name'],
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
    for (const source of [
      'clone $x =& 1',
      '$x =& new C()',
      'clone $x =& static()',
      'clone $x =& $y++ + 2',
      'clone $x =& $y-- - 2',
      '(int)$x =& $y++ + 2',
      'clone $x =& StAtIc /* gap */ ()',
      '(int)clone $x =& static()',
      '(int)$x =& ($y)',
      '[$x] =& $y',
      '$x =& LiSt($y)',
      '$x =& fn()',
      '$x =& match()',
      '$x =& array()',
      '$x =& isset($y)',
      'isset(list: $x)',
      'empty(list: $x)',
      'eval(name: "code")',
      'isset()',
      'isset(...$x)',
      'isset(&$x)',
      'empty($x,)',
      'eval("code", "extra")',
    ]) {
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

test.each(['php', 'php_only'])('%s retains intrinsic operands and ordinary named arguments', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const [source, count] of [
      ['isset($x, $y,)', 2],
      ['empty($x + 1)', 1],
      ['eval("code")', 1],
      ['lookup(list: $x, isset: $y)', 2],
    ] as const) {
      const tree = parser.parse(`<?php ${source};`)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const call = tree.rootNode.descendantsOfType('function_call_expression')[0];
        const args = call?.childForFieldName('arguments');
        expect(args?.type, source).toBe('arguments');
        expect(
          args?.namedChildren.map((arg) => arg.type),
          source
        ).toEqual(Array.from({ length: count }, () => 'argument'));
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s requires adjacent qualified name components', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const [source, invalid] of [
      [String.raw`fn\Library\read()`, false],
      ['clone $x =& $y + +2', false],
      ['clone $x =& $y - -2', false],
      ['($x++) + 2', false],
      ['($x--) - 2', false],
      [String.raw`\Class\Library\read()`, false],
      [String.raw`namespace\Class\read()`, false],
      [String.raw`Fn\ read()`, true],
      [String.raw`class\/* gap */read()`, true],
      [String.raw`fn\Library \read()`, true],
      [String.raw`fn \read()`, true],
      [String.raw`fn\Library\ /* gap */ read()`, true],
      [String.raw`\ Class\read()`, true],
      [String.raw`namespace\Class\ read()`, true],
      [String.raw`namespace \Class\read()`, true],
    ] as const) {
      const tree = parser.parse(`<?php ${source};`)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(invalid);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
