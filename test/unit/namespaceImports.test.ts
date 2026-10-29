import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const Names = ['array', 'ARRAY', 'ArRaY'];
const ImportTypes = ['', 'function ', 'const '];
await Parser.init();

test.each(['php', 'php_only'])(
  '%s distinguishes namespace-relative imports from namespace segments',
  async (dialect) => {
    const parser = new Parser().setLanguage(await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`)));
    try {
      for (const statement of [
        String.raw`use namespace\Target;`,
        String.raw`use NaMeSpAcE\Prefix\Target;`,
        String.raw`use Prefix\{namespace\Target};`,
      ]) {
        const tree = parser.parse(`<?php ${statement}`)!;
        try {
          expect(tree.rootNode.hasError, statement).toBe(true);
        } finally {
          tree.delete();
        }
      }
      for (const statement of [
        String.raw`use Prefix\namespace\Target;`,
        String.raw`use \namespace\Target;`,
        String.raw`use Prefix\{Nested\namespace\Target};`,
      ]) {
        const source = `<?php ${statement} $following = 1;`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, statement).toBe(false);
          expect(tree.rootNode.descendantsOfType('namespace_use_declaration').map((node) => node.text)).toEqual([
            statement,
          ]);
          const names = tree.rootNode.descendantsOfType('name');
          expect(names.map((node) => node.text)).toContain('namespace');
          for (const node of names) expect(source.slice(node.startIndex, node.endIndex)).toBe(node.text);
          expect(tree.rootNode.lastNamedChild?.text).toBe('$following = 1;');
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
);

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
