import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s treats a short echo tag as an echo statement', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const source of ['<?= 1, 2 ?>', '<?= 1, 2; echo 3; ?>', '<?= 1, 2;']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('php_tag').map((tag) => tag.text)).toEqual(['<?=']);
        expect(
          tree.rootNode
            .descendantsOfType('echo_statement')[0]
            ?.descendantsOfType('integer')
            .map((n) => n.text)
        ).toEqual(['1', '2']);
      } finally {
        tree.delete();
      }
    }
    for (const source of ['<?= ?>', '<?= 1, ?>', '<?php echo 0; <?= 1, 2 ?>']) {
      const tree = parser.parse(source)!;
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

test('short echo reopens PHP after a closing tag and an implicit empty body', async () => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve('tree-sitter-php.wasm')));
  const source = '<?php if (false) ?>literal <?= 1, 2 ?>end<?php echo 3;';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('if_statement')[0]?.childForFieldName('body')?.type).toBe('empty_statement');
    expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
      'php_tag',
      'if_statement',
      'text_interpolation',
      'echo_statement',
      'text_interpolation',
      'echo_statement',
    ]);
    expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(['literal ', 'end']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('closing tags complete PHP statements at their source boundary', async () => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve('tree-sitter-php.wasm')));
  try {
    for (const [source, hasError] of [
      ['<?= ?><?php 1, 2;', true],
      ['<?= 1, ?><?php 2;', true],
      ['<?php echo 1, ?><?php 2;', true],
      ['<?php if (true) ?>hello<?php else echo 1;', true],
      ['<?php if (true) ?> <?php elseif (false) echo 1;', true],
      ['<?php if (true) {} ?><?php else echo 1;', true],
      ['<?php do ?>hello<?php while (false);', true],
      ['<?php if (true) ?>\n<?php else echo 1;', false],
      ['<?php if (true) echo 2 ?>\r\n<?php else echo 1;', false],
      ['<?php do ?><?php while (false);', false],
      ['<?php if (true) ?><? else echo 1;', false],
      ['<?php do ?><? while (false);', false],
      ['<?php if (true) ?><?= 1; else echo 2;', true],
      ['<?php if (true): ?>hello<?php else: ?>world<?php endif;', false],
      ['<?php switch (1) { ?><?php case 1: break; }', false],
      ['<?php switch (1): ?><?php case 1: break; endswitch;', false],
      ['<?php switch (1) { ?><?php ; case 1: break; }', true],
      ['<?php switch (1): ?><?php ; case 1: break; endswitch;', true],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(hasError);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
