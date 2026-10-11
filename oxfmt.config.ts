// wbfy:start oxfmt-base
import type { OxfmtConfig } from 'oxfmt';

// oxlint-disable unicorn/prefer-module -- Oxfmt config files are only auto-discovered as .ts, and CommonJS avoids ESM package loading issues.
const oxfmtConfig = require('@willbooster/oxfmt-config');

const oxfmtResolvedConfig: OxfmtConfig = oxfmtConfig.default ?? oxfmtConfig;
// wbfy:end oxfmt-base

// `tree-sitter generate` writes php/src/ and php_only/src/, and `tree-sitter init` writes bindings/ in their own style.
// The grammar definitions stay identical to upstream's files, so that `diff` shows the grammar is unchanged and a later
// upstream version replaces them. The scanner differs from upstream's 0.24.2 in one statement and keeps upstream's
// style.
oxfmtResolvedConfig.ignorePatterns = [
  ...(oxfmtResolvedConfig.ignorePatterns ?? []),
  'bindings/**',
  'common/**',
  'php/**',
  'php_only/**',
];

// wbfy:start oxfmt-export
module.exports = oxfmtResolvedConfig;
// wbfy:end oxfmt-export
