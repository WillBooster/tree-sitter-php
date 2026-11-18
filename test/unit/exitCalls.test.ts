import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s parses exit and die expressions and complete call arguments', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const name of ['exit', 'die', 'EXIT', 'DiE']) {
      for (const source of [`${name};`, `$value = ${name};`, `echo ${name};`]) {
        const tree = parser.parse(`<?php ${source}`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          expect(tree.rootNode.descendantsOfType('exit_expression').map((node) => node.text)).toEqual([name]);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        `foo(${name}: 1);`,
        `${name}\\foo();`,
        `foo\\${name}();`,
        `namespace ${name}\\N; class C {const ${name}=1;} echo C::${name};`,
        `use ${name}\\N as Alias;`,
        `class C {use T {${name} as alias;}}`,
        `new C(${name}: 1);`,
        `#[A(${name}: 1)] class C {}`,
        `$object?->method(${name}: 1);`,
      ]) {
        const tree = parser.parse(`<?php ${source}`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          expect(tree.rootNode.descendantsOfType('exit_expression')).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      for (const source of [
        'echo "${' + name + '}";',
        'echo "${' + name + '[0]}";',
        'echo <<<TEXT\n${' + name + '}\nTEXT;',
        'echo `${' + name + '[0]}`;',
      ]) {
        const tree = parser.parse(`<?php ${source}`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          const variables = tree.rootNode.descendantsOfType('dynamic_variable_name');
          const names = variables.flatMap((node) => node.descendantsOfType('name').map((child) => child.text));
          expect(names).toEqual([name]);
          expect(tree.rootNode.descendantsOfType('exit_expression')).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      const dynamic = parser.parse('<?php echo "${' + name + '()}"; echo "${ ' + name + '}";')!;
      try {
        expect(dynamic.rootNode.hasError, dynamic.rootNode.toString()).toBe(false);
        expect(dynamic.rootNode.descendantsOfType('exit_expression')).toHaveLength(1);
        expect(dynamic.rootNode.descendantsOfType('function_call_expression')).toHaveLength(1);
      } finally {
        dynamic.delete();
      }
      const parenthesized = parser.parse(`<?php (${name}(...))(1);`)!;
      try {
        expect(parenthesized.rootNode.hasError, parenthesized.rootNode.toString()).toBe(false);
      } finally {
        parenthesized.delete();
      }
      for (const args of ['', '1', 'status: "bye"', '...["bye"]', '"first", print("second")', '...']) {
        const tree = parser.parse(`<?php $value = ${name}(${args});`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          const call = tree.rootNode.descendantsOfType('function_call_expression')[0];
          expect(call?.childForFieldName('function')?.text).toBe(name);
          expect(call?.childForFieldName('arguments')?.text).toBe(`(${args})`);
        } finally {
          tree.delete();
        }
      }
    }
    for (const source of [
      'exit()->method();',
      'die()::X;',
      'exit()[0];',
      'exit()();',
      'exit() = 1;',
      'exit(...)(1);',
      'exit 1;',
      'die "bye";',
      'exit(status:);',
      'exit(...,);',
      'die(...); exit(1;',
    ]) {
      const tree = parser.parse(`<?php ${source}`)!;
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
