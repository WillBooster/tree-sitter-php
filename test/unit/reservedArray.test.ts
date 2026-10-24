import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const Names = ['array', 'ARRAY', 'ArRaY'];
const Declarations = [
  ['class', 'class_declaration', '{}'],
  ['interface', 'interface_declaration', '{}'],
  ['trait', 'trait_declaration', '{}'],
  ['enum', 'enum_declaration', '{}'],
  ['function', 'function_definition', '() {}'],
] as const;
await Parser.init();

test.each(['php', 'php_only'])('%s rejects bare array declaration names regardless of case', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  try {
    for (const name of Names) {
      for (const [keyword, , ending] of Declarations) {
        const source = `<?php ${keyword} ${name}${ending}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])('%s preserves array method names when returning by reference', async (dialect) => {
  const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
  const parser = new Parser().setLanguage(language);
  try {
    for (const name of Names) {
      for (const source of [
        `<?php class Holder { function &${name}() {} }`,
        `<?php interface Holder { function &${name}(); }`,
        `<?php trait Holder { public static function &${name}() {} }`,
        `<?php enum Holder { function &${name}() {} }`,
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const methods = tree.rootNode.descendantsOfType('method_declaration');
          expect(methods.map((node) => node.childForFieldName('name')?.text)).toEqual([name]);
          expect(
            methods.flatMap((node) => node.descendantsOfType('reference_modifier').map((child) => child.text))
          ).toEqual(['&']);
        } finally {
          tree.delete();
        }
      }
      const invalidFunction = parser.parse(`<?php function &${name}() {}`)!;
      try {
        expect(invalidFunction.rootNode.hasError).toBe(true);
      } finally {
        invalidFunction.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['php', 'php_only'])(
  '%s preserves array member names, namespace names and primitive types',
  async (dialect) => {
    const language = await Language.load(path.resolve(`tree-sitter-${dialect}.wasm`));
    const parser = new Parser().setLanguage(language);
    try {
      for (const name of Names) {
        const source = `<?php namespace ${name};
class Holder {
  public $${name};
  public const ${name} = 1;
  public function ${name}(${name} $value): ${name} { return $value; }
}
$holder->${name}();
$value = ${name}(1);
consume(${name}: 1);`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('namespace_name').map((node) => node.text)).toEqual([name]);
          expect(
            tree.rootNode.descendantsOfType('method_declaration').map((node) => node.childForFieldName('name')?.text)
          ).toEqual([name]);
          expect(tree.rootNode.descendantsOfType('const_element').map((node) => node.firstNamedChild?.text)).toEqual([
            name,
          ]);
          expect(
            tree.rootNode.descendantsOfType('property_element').map((node) => node.childForFieldName('name')?.text)
          ).toEqual([`$${name}`]);
          expect(tree.rootNode.descendantsOfType('primitive_type').map((node) => node.text)).toEqual([name, name]);
          expect(tree.rootNode.descendantsOfType('array_creation_expression').map((node) => node.text)).toEqual([
            `${name}(1)`,
          ]);
        } finally {
          tree.delete();
        }
        for (const suffix of ['Value', '😀']) {
          for (const [keyword, type, ending] of Declarations) {
            const fullName = `${name}${suffix}`;
            const declaration = parser.parse(`<?php ${keyword} ${fullName}${ending}`)!;
            try {
              expect(declaration.rootNode.hasError).toBe(false);
              expect(
                declaration.rootNode.descendantsOfType(type).map((node) => node.childForFieldName('name')?.text)
              ).toEqual([fullName]);
            } finally {
              declaration.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
);
