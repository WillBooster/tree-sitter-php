// code-gauge-allow-file fileNcss 534 -- Full-parse scanner states share the lexer and immutable heredoc stack.
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

enum TokenType {
    AUTOMATIC_SEMICOLON,
    ENCAPSED_STRING_CHARS,
    ENCAPSED_STRING_CHARS_AFTER_VARIABLE,
    EXECUTION_STRING_CHARS,
    EXECUTION_STRING_CHARS_AFTER_VARIABLE,
    ENCAPSED_STRING_CHARS_HEREDOC,
    ENCAPSED_STRING_CHARS_AFTER_VARIABLE_HEREDOC,
    EOF_TOKEN,
    HEREDOC_START,
    HEREDOC_END,
    NOWDOC_STRING,
    HEREDOC_LINE_START,
    QUALIFIED_NAME_PREFIX,
    NAMESPACE_USE_PREFIX,
    NAMESPACE_USE_SEPARATOR,
    DIRECTIVE_NAME,
    EXIT_INTERPOLATION_IDENTIFIER,
    LINE_COMMENT_BODY,
    HASH_COMMENT_BODY,
    PHP_ECHO_TAG,
    SHORT_ECHO_KEYWORD,
    ADJACENT_PHP_BLOCKS,
    READONLY_CALL_NAME,
    ENUM_DECLARATION_KEYWORD,
    PLUS_SIGN,
    MINUS_SIGN,
    SENTINEL_ERROR, // Unused token used to indicate error recovery mode
};

typedef struct {
    enum TokenType symbol;
    bool after_variable;
    bool heredoc;
    bool execution;
} StringToken;

static const StringToken STRING_TOKENS[] = {
    {ENCAPSED_STRING_CHARS_AFTER_VARIABLE, true, false, false},
    {ENCAPSED_STRING_CHARS, false, false, false},
    {EXECUTION_STRING_CHARS_AFTER_VARIABLE, true, false, true},
    {EXECUTION_STRING_CHARS, false, false, true},
    {ENCAPSED_STRING_CHARS_AFTER_VARIABLE_HEREDOC, true, true, false},
    {ENCAPSED_STRING_CHARS_HEREDOC, false, true, false},
};

typedef Array(int32_t) String;

typedef struct {
    uint32_t parent;
    bool parent_can_close;
    String word;
} Heredoc;

typedef struct {
    Array(Heredoc) heredocs;
    uint32_t current;
    bool can_close;
    bool pending_echo;
} Scanner;

typedef enum { NoPrefix, PrefixRejected, PrefixAccepted } PrefixScanResult;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

// The runtime destroys the scanner at the end of each full parse. Keep immutable stack records alive until then so
// deserialization can restore any parser branch without copying labels into the fixed-size serialization buffer.
static unsigned serialize(Scanner *scanner, char *buffer) {
    if (scanner->current == 0 && !scanner->pending_echo) {
        return 0;
    }
    uint8_t flags = (scanner->can_close ? 1u : 0u) | (scanner->pending_echo ? 2u : 0u);
    if (scanner->current < 0x40) {
        buffer[0] = (char)((scanner->current << 2) | flags);
        return 1;
    }
    buffer[0] = (char)flags;
    memcpy(buffer + 1, &scanner->current, sizeof(scanner->current));
    return 1 + sizeof(scanner->current);
}

static void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    scanner->current = 0;
    scanner->can_close = false;
    scanner->pending_echo = false;
    if (length == 0) {
        return;
    }
    uint8_t packed = (uint8_t)buffer[0];
    scanner->can_close = (packed & 1u) != 0;
    scanner->pending_echo = (packed & 2u) != 0;
    if (length == 1) {
        scanner->current = packed >> 2;
    } else {
        assert(length == 1 + sizeof(scanner->current));
        memcpy(&scanner->current, buffer + 1, sizeof(scanner->current));
    }
    assert(scanner->current <= scanner->heredocs.size);
}

static Heredoc *current_heredoc(Scanner *scanner) {
    return array_get(&scanner->heredocs, scanner->current - 1);
}

static inline bool is_php_whitespace(int32_t character) {
    return character == ' ' || character == '\t' || character == '\r' || character == '\n';
}

static inline bool scan_whitespace(TSLexer *lexer) {
    for (;;) {
        while (is_php_whitespace(lexer->lookahead)) {
            advance(lexer);
        }

        if (lexer->lookahead == '/') {
            advance(lexer);

            if (lexer->lookahead == '/') {
                advance(lexer);
                while (lexer->lookahead != 0 && lexer->lookahead != '\n') {
                    advance(lexer);
                }
            } else {
                return false;
            }
        } else {
            return true;
        }
    }
}

static inline bool is_ascii_alpha(int32_t character) {
    return (((uint32_t)character | 32u) - 'a') < 26;
}

static inline bool is_ascii_digit(int32_t character) {
    return ((uint32_t)character - '0') < 10;
}

static inline bool is_ascii_xdigit(int32_t character) {
    return is_ascii_digit(character) || (((uint32_t)character | 32u) - 'a') < 6;
}

static inline int32_t ascii_tolower(int32_t character) {
    return ((uint32_t)character - 'A') < 26 ? character + ('a' - 'A') : character;
}

static inline bool is_unicode_whitespace(int32_t character) {
    if (character < 0) {
        return false;
    }
    if (character < 0x80) {
        return character == ' ' || ((uint32_t)character - '\t') < 5;
    }
    return iswspace((wint_t)character) != 0;
}

static inline bool is_horizontal_unicode_whitespace(int32_t character) {
    return character != '\r' && character != '\n' && is_unicode_whitespace(character);
}

static inline bool is_valid_name_start(TSLexer *lexer) {
    return is_ascii_alpha(lexer->lookahead) || lexer->lookahead == '_' || lexer->lookahead >= 0x80;
}

static inline bool is_valid_name_char(TSLexer *lexer) {
    return is_ascii_alpha(lexer->lookahead) || is_ascii_digit(lexer->lookahead) || lexer->lookahead == '_' ||
           lexer->lookahead >= 0x80;
}

static inline bool is_escapable_sequence(TSLexer *lexer) {
    // Note: remember to also update the escape_sequence rule in the
    // main grammar whenever changing this method
    int32_t letter = lexer->lookahead;

    if (letter == 'n' || letter == 'r' || letter == 't' || letter == 'v' || letter == 'e' || letter == 'f' ||
        letter == '\\' || letter == '$' || letter == '"') {
        return true;
    }

    if (letter == 'x') {
        advance(lexer);
        return is_ascii_xdigit(lexer->lookahead);
    }

    if (letter == 'u') {
        return true; // We handle the case where this is not really an escape
                     // sequence in grammar.js - this is needed to support the
                     // edge case "\u{$a}" in which case "\u" is to be
                     // interpreted as characters and {$a} as a variable
    }

    return ((uint32_t)letter - '0') < 8;
}

static String scan_heredoc_word(TSLexer *lexer) {
    String result = (String)array_new();

    while (is_valid_name_char(lexer)) {
        array_push(&result, lexer->lookahead);
        advance(lexer);
    }

    return result;
}

static inline bool scan_heredoc_end_prefix(Scanner *scanner, TSLexer *lexer, bool *has_content) {
    String heredoc_tag = current_heredoc(scanner)->word;
    for (uint32_t i = 0; i < heredoc_tag.size; i++) {
        if (lexer->lookahead != heredoc_tag.contents[i]) {
            return false;
        }
        advance(lexer);
        *has_content = true;
    }
    return heredoc_tag.size > 0 && !is_valid_name_char(lexer);
}

static inline bool scan_nowdoc_string(Scanner *scanner, TSLexer *lexer) {
    if (scanner->current == 0) {
        return false;
    }

    bool has_content = false;
    while (is_unicode_whitespace(lexer->lookahead)) {
        advance(lexer);
        has_content = true;
    }
    if (scan_heredoc_end_prefix(scanner, lexer, &has_content)) {
        return false;
    }

    for (;; has_content = true) {
        if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            if (has_content) {
                lexer->mark_end(lexer);
            }
            return has_content;
        }
        if (lexer->lookahead == 0 && lexer->eof(lexer)) {
            return false;
        }
        advance(lexer);
    }
}

static inline bool is_encapsed_end(int32_t character, bool is_heredoc, bool is_execution_string) {
    if (is_execution_string) {
        return character == '`';
    }
    if (is_heredoc) {
        return character == '\n' || character == '\r';
    }
    return character == '"';
}

static inline bool is_plain_encapsed_char(int32_t character, bool is_heredoc, bool is_execution_string) {
    return character != 0 && character != '\\' && character != '$' && character != '{' &&
           !is_encapsed_end(character, is_heredoc, is_execution_string);
}

static inline bool starts_encapsed_escape(TSLexer *lexer, bool is_heredoc, bool is_execution_string) {
    // \{ should not be interpreted as an escape sequence, but both should be consumed as normal characters.
    if (lexer->lookahead == '{' || (is_heredoc && lexer->lookahead == '\\')) {
        advance(lexer);
        return false;
    }
    if (is_execution_string && lexer->lookahead == '`') {
        return true;
    }
    return is_escapable_sequence(lexer);
}

static inline bool scan_heredoc_closing_line(Scanner *scanner, TSLexer *lexer, bool *has_content) {
    if (scanner->current == 0 || !scanner->can_close) {
        return false;
    }
    while (is_horizontal_unicode_whitespace(lexer->lookahead)) {
        advance(lexer);
        *has_content = true;
    }
    return scan_heredoc_end_prefix(scanner, lexer, has_content);
}

static inline bool starts_after_variable_access(TSLexer *lexer, bool *has_content) {
    if (lexer->lookahead != '[' && lexer->lookahead != '-' && lexer->lookahead != '?') {
        return false;
    }
    lexer->mark_end(lexer);
    if (lexer->lookahead == '[') {
        return true;
    }
    if (lexer->lookahead == '?') advance(lexer);
    if (lexer->lookahead == '-') {
        advance(lexer);
        if (lexer->lookahead == '>') {
            advance(lexer);
            if (is_valid_name_start(lexer)) return true;
        }
    }
    *has_content = true;
    return false;
}

static inline bool advance_encapsed_step(TSLexer *lexer, bool is_heredoc, bool is_execution_string) {
    int32_t c = lexer->lookahead;
    if (c == '\\') {
        advance(lexer);
        return !starts_encapsed_escape(lexer, is_heredoc, is_execution_string);
    }
    if (c == '$') {
        advance(lexer);
        return !is_valid_name_start(lexer) && lexer->lookahead != '{';
    }
    if (c == '{') {
        advance(lexer);
        return lexer->lookahead != '$';
    }
    do {
        advance(lexer);
    } while (is_plain_encapsed_char(lexer->lookahead, is_heredoc, is_execution_string));
    return true;
}

static bool scan_encapsed_part_string(Scanner *scanner, TSLexer *lexer, bool is_after_variable, bool is_heredoc,
                                      bool is_execution_string) {
    bool has_content = false;
    if (is_heredoc && scan_heredoc_closing_line(scanner, lexer, &has_content)) {
        return false;
    }
    if (is_after_variable && starts_after_variable_access(lexer, &has_content)) {
        return has_content;
    }
    for (;; has_content = true) {
        lexer->mark_end(lexer);
        if (is_encapsed_end(lexer->lookahead, is_heredoc, is_execution_string)) {
            return has_content;
        }
        if (lexer->lookahead == 0 && lexer->eof(lexer)) {
            return false;
        }
        if (!advance_encapsed_step(lexer, is_heredoc, is_execution_string)) {
            return has_content;
        }
    }
}

static bool scan_eof(TSLexer *lexer) {
    while (is_php_whitespace(lexer->lookahead)) {
        advance(lexer);
    }
    if (lexer->lookahead != 0 || !lexer->eof(lexer)) {
        return false;
    }
    lexer->result_symbol = EOF_TOKEN;
    return true;
}

static bool scan_heredoc_line_start(Scanner *scanner, TSLexer *lexer);

static bool scan_heredoc_end(Scanner *scanner, TSLexer *lexer);

static bool scan_heredoc_start(Scanner *scanner, TSLexer *lexer);

static PrefixScanResult scan_operand_prefix(TSLexer *lexer, const bool *valid_symbols);

static PrefixScanResult scan_expression_name(TSLexer *lexer, bool qualified, bool readonly, bool enum_declaration);
static bool scan_sign(TSLexer *lexer, enum TokenType symbol);

static bool scan_namespace_use_prefix(TSLexer *lexer);

static bool scan_namespace_use_separator(TSLexer *lexer);

static bool scan_php_gap(TSLexer *lexer);

static bool scan_php_gap_comment(TSLexer *lexer);

static bool scan_comment_tail(TSLexer *lexer, enum TokenType type);

static bool scan_line_comment_body(TSLexer *lexer, bool emit);

static bool scan_block_comment(TSLexer *lexer);

static bool scan_directive_name(TSLexer *lexer);

static bool scan_php_echo_tag(Scanner *scanner, TSLexer *lexer);

static bool scan_close_semicolon(TSLexer *lexer, const bool *valid_symbols);

static bool scan_adjacent_php_blocks(TSLexer *lexer);

static bool scan_exit_interpolation_identifier(TSLexer *lexer);

// code-gauge-allow functionCognitiveComplexity 28 -- Selects a lexical state before consuming input.
// code-gauge-allow functionNcss 45 -- Dispatches the scanner states in lexical precedence order.
static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[SENTINEL_ERROR]) {
        return false;
    }

    lexer->mark_end(lexer);

    if (scanner->pending_echo && valid_symbols[SHORT_ECHO_KEYWORD]) {
        scanner->pending_echo = false;
        lexer->result_symbol = SHORT_ECHO_KEYWORD;
        return true;
    }
    if (valid_symbols[PHP_ECHO_TAG]) {
        while (is_php_whitespace(lexer->lookahead)) {
            skip(lexer);
        }
        if (lexer->lookahead == '<') {
            return scan_php_echo_tag(scanner, lexer);
        }
    }

    if (valid_symbols[EXIT_INTERPOLATION_IDENTIFIER] &&
        (ascii_tolower(lexer->lookahead) == 'e' || ascii_tolower(lexer->lookahead) == 'd')) {
        return scan_exit_interpolation_identifier(lexer);
    }

    if (valid_symbols[LINE_COMMENT_BODY] || valid_symbols[HASH_COMMENT_BODY]) {
        return scan_comment_tail(lexer, valid_symbols[HASH_COMMENT_BODY] ? HASH_COMMENT_BODY : LINE_COMMENT_BODY);
    }

    if (valid_symbols[DIRECTIVE_NAME]) {
        return scan_directive_name(lexer);
    }

    if (valid_symbols[HEREDOC_LINE_START]) {
        return scan_heredoc_line_start(scanner, lexer);
    }

    for (size_t i = 0; i < sizeof(STRING_TOKENS) / sizeof(STRING_TOKENS[0]); i++) {
        const StringToken *token = &STRING_TOKENS[i];
        if (valid_symbols[token->symbol]) {
            lexer->result_symbol = token->symbol;
            return scan_encapsed_part_string(scanner, lexer, token->after_variable, token->heredoc, token->execution);
        }
    }

    if (valid_symbols[NOWDOC_STRING]) {
        lexer->result_symbol = NOWDOC_STRING;
        return scan_nowdoc_string(scanner, lexer);
    }

    if (valid_symbols[HEREDOC_END]) {
        return scan_heredoc_end(scanner, lexer);
    }

    PrefixScanResult prefix = scan_operand_prefix(lexer, valid_symbols);
    if (prefix != NoPrefix) {
        return prefix == PrefixAccepted;
    }

    if (valid_symbols[EOF_TOKEN]) {
        return scan_eof(lexer);
    }

    if (!scan_whitespace(lexer)) {
        return false;
    }

    if (valid_symbols[HEREDOC_START]) {
        return scan_heredoc_start(scanner, lexer);
    }

    return scan_close_semicolon(lexer, valid_symbols);
}

static bool scan_close_semicolon(TSLexer *lexer, const bool *valid_symbols) {
    if ((!valid_symbols[AUTOMATIC_SEMICOLON] && !valid_symbols[ADJACENT_PHP_BLOCKS]) || lexer->lookahead != '?') {
        return false;
    }
    advance(lexer);
    if (lexer->lookahead != '>') {
        return false;
    }
    if (valid_symbols[ADJACENT_PHP_BLOCKS] && scan_adjacent_php_blocks(lexer)) {
        lexer->result_symbol = ADJACENT_PHP_BLOCKS;
        return true;
    }
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    return valid_symbols[AUTOMATIC_SEMICOLON];
}

static bool scan_adjacent_php_blocks(TSLexer *lexer) {
    advance(lexer);
    if (lexer->lookahead == '\r') {
        advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);
    } else if (lexer->lookahead == '\n') {
        advance(lexer);
    }
    if (lexer->lookahead != '<') return false;
    advance(lexer);
    if (lexer->lookahead != '?') return false;
    advance(lexer);
    if (lexer->lookahead == '=') return false;
    lexer->mark_end(lexer);
    const char suffix[] = "php";
    for (const char *character = suffix; *character; character++) {
        if (ascii_tolower(lexer->lookahead) != *character) return true;
        advance(lexer);
    }
    if (lexer->eof(lexer) || is_php_whitespace(lexer->lookahead)) lexer->mark_end(lexer);
    return true;
}

static bool scan_php_echo_tag(Scanner *scanner, TSLexer *lexer) {
    advance(lexer);
    if (lexer->lookahead != '?') {
        return false;
    }
    advance(lexer);
    if (lexer->lookahead != '=') {
        return false;
    }
    advance(lexer);
    lexer->mark_end(lexer);
    scanner->pending_echo = true;
    lexer->result_symbol = PHP_ECHO_TAG;
    return true;
}

static bool scan_heredoc_line_start(Scanner *scanner, TSLexer *lexer) {
    lexer->result_symbol = HEREDOC_LINE_START;
    if (scanner->current > 0) {
        while (is_horizontal_unicode_whitespace(lexer->lookahead)) {
            advance(lexer);
        }
        scanner->can_close = is_valid_name_char(lexer);
    }
    return true;
}

static bool scan_heredoc_end(Scanner *scanner, TSLexer *lexer) {
    lexer->result_symbol = HEREDOC_END;
    if (scanner->current == 0) {
        return false;
    }

    Heredoc heredoc = *current_heredoc(scanner);
    while (is_unicode_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    bool has_content = false;
    if (!scan_heredoc_end_prefix(scanner, lexer, &has_content)) {
        return false;
    }

    lexer->mark_end(lexer);
    scanner->current = heredoc.parent;
    scanner->can_close = heredoc.parent_can_close;
    return true;
}

static bool scan_heredoc_start(Scanner *scanner, TSLexer *lexer) {
    lexer->result_symbol = HEREDOC_START;
    Heredoc heredoc = {
        .parent = scanner->current,
        .parent_can_close = scanner->can_close,
    };

    while (is_unicode_whitespace(lexer->lookahead)) {
        skip(lexer);
    }

    heredoc.word = scan_heredoc_word(lexer);
    if (heredoc.word.size == 0) {
        return false;
    }
    lexer->mark_end(lexer);

    array_push(&scanner->heredocs, heredoc);
    scanner->current = scanner->heredocs.size;
    scanner->can_close = false;
    return true;
}

// code-gauge-allow functionCognitiveComplexity 23 -- Checks overlapping namespace and operator tokens before scanning an ordinary expression name.
static PrefixScanResult scan_operand_prefix(TSLexer *lexer, const bool *valid_symbols) {
    bool qualified = valid_symbols[QUALIFIED_NAME_PREFIX];
    bool readonly = valid_symbols[READONLY_CALL_NAME];
    bool enum_declaration = valid_symbols[ENUM_DECLARATION_KEYWORD];
    if (valid_symbols[NAMESPACE_USE_SEPARATOR] || valid_symbols[NAMESPACE_USE_PREFIX] || qualified || readonly || enum_declaration ||
        valid_symbols[PLUS_SIGN] || valid_symbols[MINUS_SIGN]) {
        while (is_php_whitespace(lexer->lookahead)) {
            skip(lexer);
        }
    }
    if (valid_symbols[NAMESPACE_USE_SEPARATOR] && lexer->lookahead == '\\') {
        return scan_namespace_use_separator(lexer) ? PrefixAccepted : PrefixRejected;
    }
    if (valid_symbols[NAMESPACE_USE_PREFIX] && is_valid_name_start(lexer)) {
        return scan_namespace_use_prefix(lexer) ? PrefixAccepted : PrefixRejected;
    }
    if (valid_symbols[PLUS_SIGN] && lexer->lookahead == '+') {
        return scan_sign(lexer, PLUS_SIGN) ? PrefixAccepted : PrefixRejected;
    }
    if (valid_symbols[MINUS_SIGN] && lexer->lookahead == '-') {
        return scan_sign(lexer, MINUS_SIGN) ? PrefixAccepted : PrefixRejected;
    }
    if ((!qualified && !readonly && !enum_declaration) || !is_valid_name_start(lexer)) return NoPrefix;
    return scan_expression_name(lexer, qualified, readonly, enum_declaration);
}

static bool scan_sign(TSLexer *lexer, enum TokenType symbol) {
    int32_t sign = lexer->lookahead;
    advance(lexer);
    if (lexer->lookahead == sign || lexer->lookahead == '=' ||
        (sign == '-' && lexer->lookahead == '>')) {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = symbol;
    return true;
}

static const char *match_name_char(const char *suffix, int32_t c) {
    return suffix && *suffix == c ? suffix + 1 : NULL;
}

static bool scan_enum_name(TSLexer *lexer) {
    if (!scan_php_gap(lexer) || !is_valid_name_start(lexer)) return false;
    int32_t c = ascii_tolower(lexer->lookahead);
    const char *excluded = c == 'e' ? "extends" : c == 'i' ? "implements" : NULL;
    while (excluded && *excluded && ascii_tolower(lexer->lookahead) == *excluded) {
        advance(lexer);
        excluded++;
    }
    return !excluded || *excluded;
}

static PrefixScanResult scan_expression_name(TSLexer *lexer, bool qualified, bool readonly, bool enum_declaration) {
    const char *readonly_suffix = readonly ? "readonly" : NULL;
    const char *namespace_suffix = qualified ? "namespace" : NULL;
    const char *enum_suffix = enum_declaration ? "enum" : NULL;
    do {
        int32_t c = ascii_tolower(lexer->lookahead);
        readonly_suffix = match_name_char(readonly_suffix, c);
        namespace_suffix = match_name_char(namespace_suffix, c);
        enum_suffix = match_name_char(enum_suffix, c);
        advance(lexer);
    } while (is_valid_name_char(lexer));
    lexer->mark_end(lexer);
    if (qualified && (!namespace_suffix || *namespace_suffix) && lexer->lookahead == '\\') {
        advance(lexer);
        if (!is_valid_name_start(lexer)) return PrefixRejected;
        lexer->result_symbol = QUALIFIED_NAME_PREFIX;
        return PrefixAccepted;
    }
    if (readonly_suffix && !*readonly_suffix && scan_php_gap(lexer) && lexer->lookahead == '(') {
        lexer->result_symbol = READONLY_CALL_NAME;
        return PrefixAccepted;
    }
    if (enum_suffix && !*enum_suffix && scan_enum_name(lexer)) {
        lexer->result_symbol = ENUM_DECLARATION_KEYWORD;
        return PrefixAccepted;
    }
    return PrefixRejected;
}

static bool scan_namespace_use_prefix(TSLexer *lexer) {
    const char relative_prefix[] = "namespace";
    size_t length = 0;
    bool relative = true;
    while (is_valid_name_char(lexer)) {
        if (length >= sizeof(relative_prefix) - 1 || ascii_tolower(lexer->lookahead) != relative_prefix[length]) {
            relative = false;
        }
        length++;
        advance(lexer);
    }
    if ((relative && length == sizeof(relative_prefix) - 1) || lexer->lookahead != '\\') {
        return false;
    }
    lexer->mark_end(lexer);
    advance(lexer);
    if (!is_valid_name_start(lexer)) {
        return false;
    }
    lexer->result_symbol = NAMESPACE_USE_PREFIX;
    return true;
}

static bool scan_namespace_use_separator(TSLexer *lexer) {
    advance(lexer);
    lexer->mark_end(lexer);
    if (!is_valid_name_start(lexer)) {
        return false;
    }
    while (is_valid_name_char(lexer)) {
        advance(lexer);
    }
    if (!scan_php_gap(lexer) || lexer->lookahead != '\\') {
        return false;
    }
    lexer->result_symbol = NAMESPACE_USE_SEPARATOR;
    return true;
}

static bool scan_php_gap(TSLexer *lexer) {
    for (;;) {
        while (is_php_whitespace(lexer->lookahead)) {
            advance(lexer);
        }
        if (lexer->lookahead != '/' && lexer->lookahead != '#') {
            return true;
        }
        if (!scan_php_gap_comment(lexer)) {
            return false;
        }
    }
}

static bool scan_php_gap_comment(TSLexer *lexer) {
    if (lexer->lookahead == '#') {
        advance(lexer);
        return scan_line_comment_body(lexer, false);
    }
    advance(lexer);
    if (lexer->lookahead == '/') {
        advance(lexer);
        return scan_line_comment_body(lexer, false);
    }
    if (lexer->lookahead != '*') {
        return false;
    }
    advance(lexer);
    return scan_block_comment(lexer);
}

static bool scan_comment_tail(TSLexer *lexer, enum TokenType type) {
    if (type == HASH_COMMENT_BODY && lexer->lookahead == '[') {
        return false;
    }
    scan_line_comment_body(lexer, true);
    lexer->result_symbol = type;
    return true;
}

static bool scan_line_comment_body(TSLexer *lexer, bool emit) {
    while (!lexer->eof(lexer) && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
        bool question_mark = lexer->lookahead == '?';
        if (emit && question_mark) {
            lexer->mark_end(lexer);
        }
        advance(lexer);
        if (question_mark && lexer->lookahead == '>') {
            return false;
        }
    }
    if (emit) {
        lexer->mark_end(lexer);
    }
    return true;
}

static bool scan_block_comment(TSLexer *lexer) {
    while (lexer->lookahead != 0) {
        if (lexer->lookahead == '*') {
            advance(lexer);
            if (lexer->lookahead == '/') {
                advance(lexer);
                return true;
            }
        } else {
            advance(lexer);
        }
    }
    return false;
}

static bool scan_directive_name(TSLexer *lexer) {
    static const char *const keywords[] = {
        "abstract", "and", "array", "as", "break", "callable", "case",
        "catch", "class", "clone", "const", "continue", "declare", "default",
        "do", "echo", "else", "elseif", "enddeclare", "endfor", "endforeach",
        "endif", "endswitch", "endwhile", "extends", "final", "finally", "fn",
        "for", "foreach", "function", "global", "goto", "if", "implements",
        "include", "include_once", "instanceof", "insteadof", "interface", "match", "namespace",
        "new", "or", "print", "private", "protected", "public", "readonly",
        "require", "require_once", "return", "static", "switch", "throw", "trait",
        "try", "unset", "use", "var", "while", "xor", "yield",
        "list", "empty", "eval", "isset", "exit", "die", "__halt_compiler",
        "__line__", "__file__", "__dir__", "__class__", "__trait__", "__method__", "__function__",
        "__namespace__", "__property__",
    };
    while (is_php_whitespace(lexer->lookahead)) {
        skip(lexer);
    }
    if (!is_valid_name_start(lexer)) {
        return false;
    }
    char name[32];
    size_t length = 0;
    bool overflow = false;
    do {
        if (length < sizeof(name) - 1) {
            name[length++] = lexer->lookahead < 128 ? (char)ascii_tolower(lexer->lookahead) : '\x7f';
        } else {
            overflow = true;
        }
        advance(lexer);
    } while (is_valid_name_char(lexer));
    name[length] = '\0';
    if (!overflow) {
        for (size_t index = 0; index < sizeof(keywords) / sizeof(keywords[0]); index++) {
            if (strcmp(name, keywords[index]) == 0) {
                return false;
            }
        }
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = DIRECTIVE_NAME;
    return true;
}

static bool scan_exit_interpolation_identifier(TSLexer *lexer) {
    const char *word = ascii_tolower(lexer->lookahead) == 'e' ? "exit" : "die";
    for (; *word; word++) {
        if (ascii_tolower(lexer->lookahead) != *word) {
            return false;
        }
        advance(lexer);
    }
    if (lexer->lookahead != '}' && lexer->lookahead != '[') {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = EXIT_INTERPOLATION_IDENTIFIER;
    return true;
}

static inline bool external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    bool result = scan(scanner, lexer, valid_symbols);
    if (result && scanner->current > 0 &&
        (lexer->result_symbol == ENCAPSED_STRING_CHARS_HEREDOC ||
         lexer->result_symbol == ENCAPSED_STRING_CHARS_AFTER_VARIABLE_HEREDOC)) {
        scanner->can_close = false;
    }
    return result;
}

static inline void external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    for (size_t i = 0; i < scanner->heredocs.size; i++) {
        array_delete(&scanner->heredocs.contents[i].word);
    }
    array_delete(&scanner->heredocs);
    ts_free(scanner);
}

#define DEFINE_PHP_EXTERNAL_SCANNER(prefix)                                                             \
    void *prefix##_external_scanner_create(void) {                                                      \
        Scanner *scanner = ts_calloc(1, sizeof(Scanner));                                               \
        array_init(&scanner->heredocs);                                                                 \
        return scanner;                                                                                 \
    }                                                                                                   \
    unsigned prefix##_external_scanner_serialize(void *p, char *b) { return serialize((Scanner *)p, b); } \
    void prefix##_external_scanner_deserialize(void *p, const char *b, unsigned n) {                    \
        deserialize((Scanner *)p, b, n);                                                                \
    }                                                                                                   \
    bool prefix##_external_scanner_scan(void *p, TSLexer *l, const bool *s) {                           \
        return external_scanner_scan(p, l, s);                                                          \
    }                                                                                                   \
    void prefix##_external_scanner_destroy(void *p) { external_scanner_destroy(p); }
