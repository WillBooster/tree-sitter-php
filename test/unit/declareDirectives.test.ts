import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s parses declaration expressions and directive lists', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const [directives, names, values] of [
      ["encoding='UTF' . '-8'", ['encoding'], ["'UTF' . '-8'"]],
      ["encoding=('UTF-8')", ['encoding'], ["('UTF-8')"]],
      ['ticks=1, strict_types=1', ['ticks', 'strict_types'], ['1', '1']],
      ['custom=1 + 2', ['custom'], ['1 + 2']],
    ] as const) {
      for (const body of [';', '{ echo 1; }', ': echo 1; enddeclare;']) {
        const tree = parser.parse(`<?php declare(${directives})${body} $after = 1;`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          const parsed = tree.rootNode.descendantsOfType('declare_directive');
          expect(parsed.map((node) => node.childForFieldName('name')?.text)).toEqual(names);
          expect(parsed.map((node) => node.childForFieldName('value')?.text)).toEqual(values);
          expect(tree.rootNode.lastNamedChild?.text).toBe('$after = 1;');
        } finally {
          tree.delete();
        }
      }
    }
    for (const source of ['declare();', 'declare(ticks=);', 'declare(ticks=1,);', 'declare(ticks=1 strict_types=1);']) {
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
