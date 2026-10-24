import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const Names = ['\u00A0name', 'na\u200Bme', '\u2060name', 'na\uFEFFme', '𐐀name', 'emoji😀'];
await Parser.init();

test.each(['php', 'php_only'])('%s keeps non-ASCII variable names intact', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  const source = `${dialect === 'php' ? '<?php\n' : ''}${Names.map((name) => `$${name} = 1;`).join('\n')}`;
  const tree = parser.parse(source);
  try {
    expect(tree).toBeDefined();
    expect(tree!.rootNode.hasError).toBe(false);
    const variables = tree!.rootNode.descendantsOfType('variable_name');
    expect(variables.map((variable) => variable.text)).toEqual(Names.map((name) => `$${name}`));
    expect(variables.map((variable) => variable.namedChild(0)?.text)).toEqual(Names);
  } finally {
    tree?.delete();
    parser.delete();
  }
});
