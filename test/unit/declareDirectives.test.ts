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
      ['TICKS=1, Strict_Types=1', ['TICKS', 'Strict_Types'], ['1', '1']],
      ['custom=1 + 2', ['custom'], ['1 + 2']],
      [
        'emptyValue=1, 設定=2, aReallyLongDirectiveNameBeyondKeywordBuffer=3',
        ['emptyValue', '設定', 'aReallyLongDirectiveNameBeyondKeywordBuffer'],
        ['1', '2', '3'],
      ],
      ['enum=1, true=1, int=1, self=1', ['enum', 'true', 'int', 'self'], ['1', '1', '1', '1']],
    ] as const) {
      for (const body of [';', '{ echo 1; }', ': echo 1; enddeclare;']) {
        const tree = parser.parse(`<?php declare(${directives})${body} $after = 1;`)!;
        try {
          expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false);
          const parsed = tree.rootNode.descendantsOfType('declare_directive');
          expect(parsed.map((node) => node.childForFieldName('name')?.text)).toEqual(names);
          expect(parsed.map((node) => node.childForFieldName('name')?.type)).toEqual(names.map(() => 'name'));
          expect(parsed.map((node) => node.childForFieldName('value')?.text)).toEqual(values);
          expect(tree.rootNode.lastNamedChild?.text).toBe('$after = 1;');
        } finally {
          tree.delete();
        }
      }
    }
    for (const name of [
      'list',
      'empty',
      'eval',
      'isset',
      'exit',
      'die',
      '__halt_compiler',
      '__line__',
      '__file__',
      '__dir__',
      '__class__',
      '__trait__',
      '__method__',
      '__function__',
      '__namespace__',
      '__property__',
      'class',
      'function',
    ]) {
      for (const spelling of [name, name.toUpperCase()]) {
        const tree = parser.parse(`<?php declare(${spelling}=1);`)!;
        try {
          expect(tree.rootNode.hasError, spelling).toBe(true);
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
