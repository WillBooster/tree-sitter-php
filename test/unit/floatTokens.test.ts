import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s distinguishes floats from exponent-shaped identifiers', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const name of ['e2', 'E1', 'e10', 'E10', 'e2x', 'e_2', '_1e2']) {
      const source = `<?php function ${name}() { return 1; } const ${name} = 2; echo ${name}() + ${name};`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
        expect(tree.rootNode.descendantsOfType('float')).toHaveLength(0);
        expect(
          tree.rootNode.descendantsOfType('function_call_expression')[0]?.childForFieldName('function')?.text
        ).toBe(name);
      } finally {
        tree.delete();
      }
    }
    for (const value of ['0.0', '1.', '.1', '1e2', '1E+2', '1e-2', '1.e2', '.1e2', '1_000.2_5e1_0', '1_0e2_0']) {
      const tree = parser.parse(`<?php echo ${value};`)!;
      try {
        expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
        expect(tree.rootNode.descendantsOfType('float').map((node) => node.text)).toEqual([value]);
      } finally {
        tree.delete();
      }
    }
    for (const value of ['.', '1_.0', '0._1', '1_e2', '.1_e2', '1e_2', '1e+_2']) {
      const tree = parser.parse(`<?php echo ${value};`)!;
      try {
        expect(tree.rootNode.hasError, value).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
