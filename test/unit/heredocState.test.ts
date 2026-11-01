import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();

test.each(['php', 'php_only'])('%s preserves long string delimiters and following statements', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const label of ['X'.repeat(254), 'Y'.repeat(255), 'Z'.repeat(4096), '😀'.repeat(1024)]) {
      for (const quote of ['', '"', "'"]) {
        const nowdoc = quote === "'";
        const body = `${label}suffix\n${label.replace(/.$/u, '')}\ntext $value`;
        const source = `<?php\n$result = <<<${quote}${label}${quote}\n${body}\n${label};\n$following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const strings = tree.rootNode.descendantsOfType(nowdoc ? 'nowdoc' : 'heredoc');
          expect(strings).toHaveLength(1);
          const string = strings[0]!;
          expect(string.childrenForFieldName('end_tag').map((node) => node.text)).toEqual([label]);
          expect(string.text).toBe(`<<<${quote}${label}${quote}\n${body}\n${label}`);
          expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
          expect(tree.rootNode.lastNamedChild?.startIndex).toBe(source.indexOf('$following'));
          expect(tree.rootNode.descendantsOfType('variable_name').map((node) => node.text)).toEqual(
            nowdoc ? ['$result', '$following'] : ['$result', '$value', '$following']
          );
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s restores nested heredoc delimiters beyond the snapshot limit', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  const labels = Array.from({ length: 256 }, (_, index) => `TAG${index}XXXXXXXX`);
  const source = `<?php
$result = <<<${labels[0]}
${labels
  .slice(1)
  .map((label) => `{$values[<<<${label}\n`)
  .join('')}body
${labels.toReversed().join('\n]}\n')};
$following = 1;`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('heredoc_start').map((node) => node.text)).toEqual(labels);
    expect(tree.rootNode.descendantsOfType('heredoc_end').map((node) => node.text)).toEqual(labels.toReversed());
    expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
    expect(tree.rootNode.lastNamedChild?.startIndex).toBe(source.indexOf('$following'));
  } finally {
    tree.delete();
    parser.delete();
  }
});
