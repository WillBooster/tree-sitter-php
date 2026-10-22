import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generationInputMtime } from '../helpers/generationInputs.js';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');
const Prefixes = { php: '<?php\n', php_only: '' };
const ErrorLine = '$ a\n';
await Parser.init();

for (const [grammar, prefix] of Object.entries(Prefixes)) {
  const wasmPath = path.join(Root, `tree-sitter-${grammar}.wasm`);
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasmPath));

  describe(grammar, () => {
    // The tests load the existing Wasm build, so a stale one would hide an edit that makes error recovery slower than
    // linear.
    test('uses a Wasm build built from the current parser', () => {
      const sources = [
        'common/define-grammar.js',
        'common/scanner.h',
        `${grammar}/grammar.js`,
        `${grammar}/src/parser.c`,
        `${grammar}/src/scanner.c`,
        `${grammar}/src/tree_sitter/parser.h`,
      ].map((name) => fs.statSync(path.join(Root, name)).mtimeMs);
      expect(
        Math.max(generationInputMtime(Root), ...sources) > fs.statSync(wasmPath).mtimeMs,
        `generation inputs or ${grammar}/src/ changed after the Wasm build was built; run \`bun run build/ci\``
      ).toBe(false);
    });

    test('parses interpolation-heavy heredoc lines in linear time', { timeout: 60_000 }, () => {
      for (const fragment of ['$foo x ', '{$foo}SQL.PHP_EOL ']) {
        const source = (count: number): string => `${prefix}$a = <<<SQL\n${fragment.repeat(count)}\nSQL;\n`;
        expectLinearCpuTime(parser, source(200), source(2000), false, fragment);
      }
    });

    test.each([
      ['qualified', 'Target'],
      ['grouped', '{Target}'],
    ])('parses long %s import paths in linear time', { timeout: 60_000 }, (_name, ending) => {
      const source = (count: number): string => `${prefix}use array\\${'Segment\\'.repeat(count)}${ending};`;
      expectLinearCpuTime(parser, source(200), source(2000), false);
    });

    // Thread CPU time excludes parallel test processes and background Wasm compilation.
    test.each([
      ['invalid variable', ErrorLine, 2000],
      ['non-ASCII identifier', '\u00A0\n', 1000],
    ])('recovers from repeated %s lines in linear time', { timeout: 60_000 }, (_name, line, count) => {
      const small = prefix + line.repeat(count);
      const large = prefix + line.repeat(count * 10);
      expectLinearCpuTime(parser, small, large);
    });
  });
}

function expectLinearCpuTime(
  parser: Parser,
  small: string,
  large: string,
  expectedError = true,
  context?: string
): void {
  parseCpuTime(parser, large, expectedError);
  parseCpuTime(parser, large, expectedError);
  let repetitions = 1;
  while (parseCpuTime(parser, small, expectedError, repetitions) < 10_000) {
    repetitions *= 2;
  }
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(parser, small, expectedError, repetitions));
    largeFastest = Math.min(largeFastest, parseCpuTime(parser, large, expectedError, repetitions));
  }
  expect(largeFastest / smallFastest, context).toBeLessThan(18);
}

function parseCpuTime(parser: Parser, source: string, expectedError = true, repetitions = 1): number {
  const start = process.threadCpuUsage();
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const tree = parser.parse(source);
    if (!tree) throw new Error('The parser returned no tree');
    const { hasError } = tree.rootNode;
    tree.delete();
    expect(hasError).toBe(expectedError);
  }
  const { system, user } = process.threadCpuUsage(start);
  return system + user;
}
