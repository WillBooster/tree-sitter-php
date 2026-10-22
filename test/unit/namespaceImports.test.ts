import path from 'node:path';
import { expect, test } from 'vitest';

import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';

const Names = ['array', 'ARRAY', 'ArRaY'];
const ImportTypes = ['', 'function ', 'const '];
await Parser.init();

test.each(['php', 'php_only'])(
  '%s preserves comments and whitespace around a final group separator',
  async (dialect) => {
    const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
    try {
      for (const start of ['array', String.raw`\array`]) {
        for (const type of ImportTypes) {
          for (const trivia of [' ', '/**/', ' /* gap */ ', '\r\n', '// gap\n', '# gap\n']) {
            for (const separator of [String.raw`\{`, String.raw`\ {`, String.raw`\/* gap */{`]) {
              const statement = `use ${type}${start}\\Prefix${trivia}${separator}Target};`;
              const tree = parser.parse(`<?php ${statement} $following = 1;`)!;
              try {
                expect(tree.rootNode.hasError, statement).toBe(false);
                expect(tree.rootNode.descendantsOfType('namespace_use_declaration').map((node) => node.text)).toEqual([
                  statement,
                ]);
                expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test.each(['php', 'php_only'])(
  '%s distinguishes a const namespace prefix from an import type after edits',
  async (dialect) => {
    const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
    try {
      for (const keyword of ['const', 'CoNsT']) {
        const prefix = `<?php use ${keyword}`;
        let spacing = '';
        let tree = parser.parse(`${prefix}\\Target;`)!;
        try {
          for (const replacement of [' ', '']) {
            tree.edit(
              new Edit({
                startIndex: prefix.length,
                oldEndIndex: prefix.length + spacing.length,
                newEndIndex: prefix.length + replacement.length,
                startPosition: { row: 0, column: prefix.length },
                oldEndPosition: { row: 0, column: prefix.length + spacing.length },
                newEndPosition: { row: 0, column: prefix.length + replacement.length },
              })
            );
            const source = `${prefix}${replacement}\\Target;`;
            const changed = parser.parse(source, tree)!;
            const fresh = parser.parse(source)!;
            try {
              expect(changed.rootNode.hasError).toBe(false);
              expect(changed.rootNode.toString()).toBe(fresh.rootNode.toString());
              expect(
                changed.rootNode
                  .descendantsOfType('namespace_use_clause')
                  .map((node) => node.childForFieldName('type')?.text)
              ).toEqual([replacement ? keyword : undefined]);
              expect(changed.rootNode.descendantsOfType('qualified_name').map((node) => node.text)).toEqual([
                replacement ? String.raw`\Target` : `${keyword}\\Target`,
              ]);
            } finally {
              fresh.delete();
            }
            tree.delete();
            tree = changed;
            spacing = replacement;
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test.each(['php', 'php_only'])('%s rejects bare reserved array imports', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const name of Names) {
      for (const type of ImportTypes) {
        for (const statement of [
          `use ${type}${name};`,
          `use ${type}${name} as Alias;`,
          `use Prefix\\{${type}${name} as Alias};`,
          `use ${type}${name}\\{Target};`,
        ]) {
          const tree = parser.parse(`<?php ${statement}`)!;
          try {
            expect(tree.rootNode.hasError, statement).toBe(true);
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s preserves qualified keyword import paths and names', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const name of [...Names, 'const', 'function', 'match', 'if', 'mixed', 'string']) {
      for (const type of ImportTypes) {
        for (const statement of [
          `use ${type}${name}\\Target as Alias;`,
          `use ${type}\\${name} as Alias;`,
          `use ${type}Prefix\\${name} as Alias;`,
          `use ${type}\\${name}\\{Target};`,
          `use ${type}${name}\\Prefix\\{Target};`,
          `use Prefix\\{${type}${name}\\Target as Alias};`,
        ]) {
          const source = `<?php namespace ${name}; ${statement} $following = 1;`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, statement).toBe(false);
            const imports = tree.rootNode.descendantsOfType('namespace_use_declaration');
            expect(imports.map((node) => node.text)).toEqual([statement]);
            expect(imports.flatMap((node) => node.descendantsOfType('name').map((child) => child.text))).toContain(
              name
            );
            expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s reparses an array import after adding a path and undoing it', async (dialect) => {
  const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
  try {
    for (const type of ImportTypes) {
      const prefix = `<?php use ${type}array`;
      let suffix = '';
      let tree = parser.parse(`${prefix};`)!;
      try {
        expect(tree.rootNode.hasError).toBe(true);
        for (const replacement of [String.raw`\Target`, '']) {
          tree.edit(
            new Edit({
              startIndex: prefix.length,
              oldEndIndex: prefix.length + suffix.length,
              newEndIndex: prefix.length + replacement.length,
              startPosition: { row: 0, column: prefix.length },
              oldEndPosition: { row: 0, column: prefix.length + suffix.length },
              newEndPosition: { row: 0, column: prefix.length + replacement.length },
            })
          );
          const source = `${prefix}${replacement};`;
          const changed = parser.parse(source, tree)!;
          const fresh = parser.parse(source)!;
          try {
            expect(changed.rootNode.hasError).toBe(replacement === '');
            expect(changed.rootNode.toString()).toBe(fresh.rootNode.toString());
            expect(
              changed.rootNode
                .descendantsOfType('qualified_name')
                .map((node) => [node.text, node.startIndex, node.endIndex])
            ).toEqual(
              fresh.rootNode
                .descendantsOfType('qualified_name')
                .map((node) => [node.text, node.startIndex, node.endIndex])
            );
          } finally {
            fresh.delete();
          }
          tree.delete();
          tree = changed;
          suffix = replacement;
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
