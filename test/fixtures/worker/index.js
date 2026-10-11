// A Cloudflare Worker that parses its request body with the grammar named by the request path. Workers cannot compile
// Wasm from bytes at run time, so the runtime and the grammars are imported as precompiled modules.
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';

import phpOnly from '../../../tree-sitter-php_only.wasm';
import php from '../../../tree-sitter-php.wasm';

const modules = { php, php_only: phpOnly };
const languages = {};

export default {
  async fetch(request) {
    const grammar = new URL(request.url).pathname.slice(1);
    languages[grammar] ??= Parser.init({ wasmModule: runtime }).then(() => Language.load(modules[grammar]));
    const language = await languages[grammar];
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(await request.text());
    return new Response(tree.rootNode.toString());
  },
};
