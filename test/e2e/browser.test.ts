import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { expect, test } from 'vitest';

import phpUrl from '../../tree-sitter-php.wasm?url';
import phpOnlyUrl from '../../tree-sitter-php_only.wasm?url';
import { ExpectedTrees } from '../fixtures/parse.js';

const Urls = { php: phpUrl, php_only: phpOnlyUrl };

test.each(Object.entries(ExpectedTrees))(
  'parses with the %s grammar in a browser, loading the Wasm files over HTTP',
  async (grammar, { source, tree }) => {
    await Parser.init({ locateFile: () => runtimeUrl });
    const parser = new Parser();
    parser.setLanguage(await Language.load(Urls[grammar as keyof typeof Urls]));
    expect(parser.parse(source)?.rootNode.toString()).toBe(tree);
  }
);
