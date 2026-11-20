import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test('only <?php followed by whitespace or the end of input, and <?=, open PHP code', async () => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve('tree-sitter-php.wasm')));
  try {
    for (const [source, tags, texts] of [
      ['<?php echo 1; ?><?xml version="1.0"?>', ['<?php'], ['<?xml version="1.0"?>']],
      ['<?xml version="1.0"?>\n<?php echo 1;', ['<?php'], ['<?xml version="1.0"?>\n']],
      ['<? echo 1; ?>', [], ['<? echo 1; ?>']],
      ['a<?php?>b<?phpx<?PhP\techo 1; ?>c<?= 2 ?>', ['<?PhP', '<?='], ['a<?php?>b<?phpx', 'c']],
      ['x<?php', ['<?php'], ['x']],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('php_tag').map((node) => node.text)).toEqual(tags);
        expect(tree.rootNode.descendantsOfType('text').map((node) => node.text)).toEqual(texts);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
