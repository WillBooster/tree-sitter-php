import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const Names = [
  'array',
  'function',
  'match',
  'ArRaY',
  'FuNcTiOn',
  'MaTcH',
  'arrayValue',
  'function😀',
  'match\u00A0Value',
];
await Parser.init();

test.each(['php', 'php_only'])('%s preserves keyword prefixes in qualified expression names', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(qualified_name) @qualified');
  try {
    for (const name of Names) {
      const qualified = `${name}\\Target`;
      const bodies = [
        `consume(${qualified});`,
        `consume(\n/* leading */\t${qualified});`,
        `$value = ${qualified}();`,
        `$value = ${qualified}::VALUE;`,
        `$value = new ${qualified}();`,
        `use ${qualified};`,
        `use function ${qualified};`,
        `function consume(${qualified} $value): ${qualified} { return $value; }`,
      ];
      for (const body of bodies) {
        const source = `${dialect === 'php' ? '<?php\n' : ''}${body}\n$following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const expected = Array.from({ length: body.includes('function consume(') ? 2 : 1 }, () => qualified);
          expect(
            query.captures(tree.rootNode).map(({ node }) => node.text),
            source
          ).toEqual(expected);
          expect(
            tree.rootNode
              .descendantsOfType('qualified_name')
              .map((node) => node.namedChildren.map((child) => child.text))
          ).toEqual(expected.map(() => [name, 'Target']));
          expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test.each(['php', 'php_only'])(
  '%s preserves keyword expressions and rejects incomplete qualified names',
  async (dialect) => {
    const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
    const parser = new Parser().setLanguage(language);
    const source = `${dialect === 'php' ? '<?php\n' : ''}$array = array(1, 2);
$closure = function($value) { return $value; };
$result = match($value) { 1 => 2, default => 3 };
consume(array: 1, function: 2, match: 3);`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('array_creation_expression').map((node) => node.text)).toEqual([
        'array(1, 2)',
      ]);
      expect(tree.rootNode.descendantsOfType('anonymous_function').map((node) => node.text)).toEqual([
        'function($value) { return $value; }',
      ]);
      expect(tree.rootNode.descendantsOfType('match_expression').map((node) => node.text)).toEqual([
        'match($value) { 1 => 2, default => 3 }',
      ]);
      expect(tree.rootNode.descendantsOfType('qualified_name')).toHaveLength(0);
      for (const queryPath of ['highlights', 'injections', 'tags', ...(dialect === 'php' ? ['injections-text'] : [])]) {
        const query = new Query(language, fs.readFileSync(`queries/${queryPath}.scm`, 'utf8'));
        try {
          query.captures(tree.rootNode);
        } finally {
          query.delete();
        }
      }
      for (const keyword of ['array', 'function', 'match']) {
        for (const body of [
          `consume(${keyword}\\);`,
          `consume(${keyword} \\Target);`,
          ...(keyword === 'array' ? [] : [`class ${keyword} {}`, `function ${keyword}() {}`]),
        ]) {
          const invalid = parser.parse(`${dialect === 'php' ? '<?php\n' : ''}${body}`)!;
          try {
            expect(invalid.rootNode.hasError, body).toBe(true);
          } finally {
            invalid.delete();
          }
        }
      }
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);
