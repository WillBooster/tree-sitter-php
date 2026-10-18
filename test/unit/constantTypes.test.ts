import { expect } from 'vitest';

import { testCommand } from './run.js';

testCommand(
  'exposes class constant types through type supertype queries',
  ['script/tree-sitter', 'query', 'test/fixtures/constantTypes.scm', 'test/fixtures/constantTypes.php'],
  300_000,
  {
    check(output) {
      const captures = [...output.matchAll(/capture: \d+ - (\w+),[^\n]*text: `([^`]+)`/g)].map(([, name, text]) => [
        name,
        text,
      ]);
      expect(captures).toEqual([
        ['type', 'static'],
        ['named', 'static'],
        ['type', String.raw`if\X`],
        ['named', String.raw`if\X`],
        ['type', 'int'],
      ]);
    },
  }
);
