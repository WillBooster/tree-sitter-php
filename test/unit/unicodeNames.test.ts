import path from 'node:path';
import { expect, test } from 'vitest';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Names = ['\u00A0name', 'na\u200Bme', '\u2060name', 'na\uFEFFme', '𐐀name', 'emoji😀', 'return\u00A0value'];
await Parser.init();

test.each(['php', 'php_only'])('%s preserves complete non-ASCII declaration and reference names', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  try {
    for (const name of Names) {
      for (const body of [
        `function ${name}() {}\n${name}();`,
        `class ${name} {}\nnew ${name}();`,
        `const ${name} = 1;\necho ${name};`,
      ]) {
        const tree = parser.parse(`${dialect === 'php' ? '<?php\n' : ''}${body}\n$following = 1;`)!;
        try {
          expect(tree.rootNode.hasError, body).toBe(false);
          expect(
            tree.rootNode
              .descendantsOfType('name')
              .filter((node) => node.parent?.type !== 'variable_name')
              .map((node) => node.text),
            body
          ).toEqual([name, name]);
          expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});
