// A source and the tree it parses to with each grammar: `php` starts in text and needs the opening tag to enter PHP
// code, while `php_only` starts in PHP code.
export const ExpectedTrees = {
  php: {
    source: '<?php\necho "Hello, World!";\n',
    tree: '(program (php_tag) (echo_statement (encapsed_string (string_content))))',
  },
  php_only: {
    source: 'echo "Hello, World!";\n',
    tree: '(program (echo_statement (encapsed_string (string_content))))',
  },
};
