# @willbooster/tree-sitter-php

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-php.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-php)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-php.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-php)
[![Test](https://github.com/WillBooster/tree-sitter-php/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-php/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-php/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-php/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.41.8-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-php.svg)](https://crates.io/crates/willbooster-tree-sitter-php)

PHP grammars for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter/tree-sitter-php](https://github.com/tree-sitter/tree-sitter-php). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork builds on upstream's version 0.24.2 grammars and queries with support for absolute grouped namespace imports
and asymmetric visibility in constructor property promotion.
Its external scanner adapts to the generated array API and fixes incremental heredoc parsing. It generates the parsers with the
[WillBooster/tree-sitter](https://github.com/WillBooster/tree-sitter) generator. The parsers carry that fork's own ABI
number `0x57420006`, so they load only with its 7.x runtime (`willbooster-tree-sitter`,
`@willbooster/web-tree-sitter`), version 7.0.10 or later. That runtime loads no parser that upstream's generator wrote.

It holds two grammars, as upstream does: `php` parses PHP embedded in text, which starts in text mode and enters PHP at
an opening tag such as `<?php`, and `php_only` parses PHP code on its own, where the opening tag is optional.

## Usage

The npm package ships `tree-sitter-php.wasm` and `tree-sitter-php_only.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter) version 7.0.10 or later in the 7.x series, which runs in Node.js, Bun, browsers, and Cloudflare Workers. In Node.js and Bun, load the grammar from its path:

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-php/tree-sitter-php.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('<?php\necho "Hello, World!";\n');
```

In browsers, serve both `.wasm` files and load them by URL (the example uses Vite's `?url` imports):

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import phpUrl from '@willbooster/tree-sitter-php/tree-sitter-php.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(phpUrl));
```

Cloudflare Workers do not allow compiling Wasm at run time, so import both `.wasm` files as modules, with or without
Node.js compatibility:

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';
import php from '@willbooster/tree-sitter-php/tree-sitter-php.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(php));
```

The package also ships the grammar definitions (`common/define-grammar.js`, `php/grammar.js`, and
`php_only/grammar.js`), the queries in `queries/`, and the node types in `php/src/node-types.json` and
`php_only/src/node-types.json`.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-php) and on
[willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter), the runtime this package is tested and
fuzzed with:

```toml
[dependencies]
tree-sitter = { package = "willbooster-tree-sitter", version = "7.0.10" }
tree-sitter-php = { package = "willbooster-tree-sitter-php", version = "2" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_php::LANGUAGE_PHP.into())?;
```

`tree_sitter_php::LANGUAGE_PHP_ONLY` is the `php_only` grammar.

## Development

```sh
mise install
bun install --frozen-lockfile
bun run test/ci-setup # installs Chromium for the browser test
bun run build/ci
bun run test
script/parse-examples
cargo test
```

The scripts and tests generate, build, test, and parse with `script/tree-sitter`, the tree-sitter CLI of the
WillBooster/tree-sitter runtime version locked in `Cargo.lock`, since the generator and the runtime of upstream's CLI are
not the ones this package ships with. Its first run downloads that CLI from the runtime's GitHub Release, or builds it
with `cargo` (whose build runs the CMake that `mise.toml` pins) when the download fails or the release has no binary that runs here. Run other CLI commands through it as
well (e.g. `script/tree-sitter parse --grammar-path php file.php`).

`bun run generate` records a fresh generation profile from the applicable `test/corpus` cases and Git-tracked
files in `examples/` for each grammar, then generates compact parser tables. The parsers also embed metadata from `tree-sitter.json`. After changing a grammar,
`tree-sitter.json`, a corpus case, or a tracked example,
regenerate and commit `php/src/` and `php_only/src/`. Stage added or removed examples with `git add -A examples` before generation so the profile uses the intended file list.
Profiles in `.tmp/generation-profiles/` are temporary and must not be committed. `bun run build-wasm`, `bun run build/ci`,
and the release build regenerate the parsers before compiling them.

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK).
  Its cases belong to the `php` grammar unless they are marked `:language(php_only)`;
- an incremental-parsing check (`test/unit/incremental.test.ts`): `script/fuzz-corpus` runs `tree-sitter fuzz` for a
  grammar, which edits each of its corpus cases at random, reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`,
  `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits. It runs every corpus case with both grammars,
  except the cases `script/fuzz-corpus` excludes;
- a check that the real-world PHP files in `examples/`, those of the cloned repositories, fail to parse with the `php`
  grammar exactly as listed in `script/known-failures.txt`. The first run clones the repositories. The example repositories are pinned to commits in
  `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples` rewrites it;
  review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each line takes linear
  time with both grammars, since consumers parse files while they are being edited. It loads the Wasm builds through
  @willbooster/web-tree-sitter, which `bun run build/ci` rebuilds after regenerating the parsers;
- a check (`test/unit/runtimeVersion.test.ts`) that `@willbooster/web-tree-sitter` in `package.json` and
  `willbooster-tree-sitter` in `Cargo.lock` are the same version, since the Wasm tests run on the former and the Rust
  tests, the fuzzer, and the CLI on the latter;
- tests that load the Wasm builds with @willbooster/web-tree-sitter in Chromium (`test/e2e/browser.test.ts`) and in
  Cloudflare Workers with and without Node.js compatibility (`test/e2e/workers.test.ts`).

The tests compile the parsers into `.tmp/tree-sitter-lib` rather than the CLI's cache shared by every checkout;
`script/fuzz-corpus` and `script/parse-examples` build a parser of their own in `.tmp/` for each run and delete it
afterwards.

CI also runs these tests on Linux arm64 and macOS, where the CLI compiles the parsers and the scanner natively, and
fuzzes both parsers with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

### References

- [PHP Language Reference](https://www.php.net/manual/en/langref.php)
