// A source and the tree it parses to with each grammar: `php` needs the opening tag, which `php_only` does not accept.
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
