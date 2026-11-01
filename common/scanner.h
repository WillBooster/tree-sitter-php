#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wchar.h>
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
    QUALIFIED_KEYWORD,
    NAMESPACE_USE_PREFIX,
    NAMESPACE_USE_SEPARATOR,
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

static inline bool string_eq(String *self, String *other) {
    if (self->size != other->size) {
        return false;
    }
    return self->size == 0 || memcmp(self->contents, other->contents, self->size * sizeof(self->contents[0])) == 0;
}

typedef struct {
    uint32_t parent;
    bool parent_can_close;
    String word;
} Heredoc;

typedef struct {
    Array(Heredoc) heredocs;
    uint32_t current;
    bool can_close;
} Scanner;

typedef enum { NoPrefix, PrefixRejected, PrefixAccepted } PrefixScanResult;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

// The runtime destroys the scanner at the end of each full parse. Keep immutable stack records alive until then so
// deserialization can restore any parser branch without copying labels into the fixed-size serialization buffer.
static unsigned serialize(Scanner *scanner, char *buffer) {
    if (scanner->current == 0) {
        return 0;
    }
    memcpy(buffer, &scanner->current, sizeof(scanner->current));
    buffer[sizeof(scanner->current)] = scanner->can_close;
    return sizeof(scanner->current) + 1;
}

static void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    scanner->current = 0;
    scanner->can_close = false;
    if (length == 0) {
        return;
    }
    assert(length == sizeof(scanner->current) + 1);
    memcpy(&scanner->current, buffer, sizeof(scanner->current));
    assert(scanner->current <= scanner->heredocs.size);
    scanner->can_close = buffer[sizeof(scanner->current)] != 0;
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

static inline bool is_valid_name_start(TSLexer *lexer) {
    return lexer->lookahead == '_' || lexer->lookahead >= 0x80 || iswalpha(lexer->lookahead);
}

static inline bool is_valid_name_char(TSLexer *lexer) {
    return iswalnum(lexer->lookahead) || lexer->lookahead == '_' || lexer->lookahead >= 0x80;
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
        return iswxdigit(lexer->lookahead);
    }

    if (letter == 'u') {
        return true; // We handle the case where this is not really an escape
                     // sequence in grammar.js - this is needed to support the
                     // edge case "\u{$a}" in which case "\u" is to be
                     // interpreted as characters and {$a} as a variable
    }

    return iswdigit(lexer->lookahead) && lexer->lookahead >= '0' && lexer->lookahead <= '7';
}

static String scan_heredoc_word(TSLexer *lexer) {
    String result = (String)array_new();

    while (is_valid_name_char(lexer)) {
        array_push(&result, lexer->lookahead);
        advance(lexer);
    }

    return result;
}

static inline bool scan_nowdoc_string(Scanner *scanner, TSLexer *lexer) {
    bool has_consumed_content = false;
    if (scanner->current == 0) {
        return false;
    }

    while (iswspace(lexer->lookahead)) {
        advance(lexer);
        has_consumed_content = true;
    }

    bool end_tag_matched = false;
    String heredoc_tag = current_heredoc(scanner)->word;

    for (uint32_t i = 0; i < heredoc_tag.size; i++) {
        if (lexer->lookahead != heredoc_tag.contents[i]) {
            break;
        }
        advance(lexer);
        has_consumed_content = true;

        end_tag_matched = (i == heredoc_tag.size - 1 && !is_valid_name_char(lexer));
    }

    if (end_tag_matched) {
        return false;
    }

    for (bool has_content = has_consumed_content;; has_content = true) {
        lexer->mark_end(lexer);

        switch (lexer->lookahead) {
            case '\n':
            case '\r':
                return has_content;
            default:
                if (lexer->eof(lexer)) {
                    return false;
                }
                advance(lexer);
        }
    }

    return false;
}

static bool scan_encapsed_part_string(Scanner *scanner, TSLexer *lexer, bool is_after_variable, bool is_heredoc,
                                      bool is_execution_string) {
    bool has_consumed_content = false;

    if (is_heredoc && scanner->current > 0 && scanner->can_close) {
        while (iswspace(lexer->lookahead) && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
            advance(lexer);
            has_consumed_content = true;
        }

        String heredoc_tag = current_heredoc(scanner)->word;

        bool end_tag_matched = false;

        for (uint32_t i = 0; i < heredoc_tag.size; i++) {
            if (lexer->lookahead != heredoc_tag.contents[i]) {
                break;
            }
            has_consumed_content = true;
            advance(lexer);

            end_tag_matched = (i == heredoc_tag.size - 1 && !is_valid_name_char(lexer));
        }

        if (end_tag_matched) {
            return false;
        }
    }

    for (bool has_content = has_consumed_content;; has_content = true) {
        lexer->mark_end(lexer);

        switch (lexer->lookahead) {
            case '"':
                if (!is_heredoc && !is_execution_string) {
                    return has_content;
                }
                advance(lexer);
                break;
            case '`':
                if (is_execution_string) {
                    return has_content;
                }
                advance(lexer);
                break;
            case '\n':
            case '\r':
                if (is_heredoc) {
                    return has_content;
                }
                advance(lexer);
                break;
            case '\\':
                advance(lexer);

                // \{ should not be interpreted as an escape sequence, but both
                // should be consumed as normal characters
                if (lexer->lookahead == '{') {
                    advance(lexer);
                    break;
                }

                if (is_execution_string && lexer->lookahead == '`') {
                    return has_content;
                }

                if (is_heredoc && lexer->lookahead == '\\') {
                    advance(lexer);
                    break;
                }

                if (is_escapable_sequence(lexer)) {
                    return has_content;
                }
                break;
            case '$':
                advance(lexer);

                if ((is_valid_name_char(lexer) && !iswdigit(lexer->lookahead)) || lexer->lookahead == '{') {
                    return has_content;
                }
                break;
            case '-':
                if (is_after_variable) {
                    advance(lexer);
                    if (lexer->lookahead == '>') {
                        advance(lexer);
                        if (is_valid_name_char(lexer)) {
                            return has_content;
                        }
                        break;
                    }
                    break;
                }
            case '[':
                if (is_after_variable) {
                    return has_content;
                }
                advance(lexer);
                break;
            case '{':
                advance(lexer);
                if (lexer->lookahead == '$') {
                    return has_content;
                }
                break;
            default:
                if (lexer->eof(lexer)) {
                    return false;
                }
                advance(lexer);
        }

        is_after_variable = false;
    }

    return false;
}

static bool scan_eof(TSLexer *lexer) {
    while (is_php_whitespace(lexer->lookahead)) {
        advance(lexer);
    }
    if (!lexer->eof(lexer)) {
        return false;
    }
    lexer->result_symbol = EOF_TOKEN;
    return true;
}

static const char *qualified_keyword_start(TSLexer *lexer);

static bool scan_qualified_keyword(TSLexer *lexer, const char *word);

static PrefixScanResult scan_name_prefix(TSLexer *lexer, const bool *valid_symbols);

static bool scan_namespace_use_prefix(TSLexer *lexer);

static bool scan_namespace_use_separator(TSLexer *lexer);

static bool scan_namespace_use_gap(TSLexer *lexer);

static bool scan_namespace_use_comment(TSLexer *lexer);

static bool scan_namespace_use_line_comment(TSLexer *lexer);

static bool scan_namespace_use_block_comment(TSLexer *lexer);

// code-gauge-allow functionNcss 60 -- Splitting the unchanged token dispatch would move complexity into mechanical helpers.
// code-gauge-allow functionCognitiveComplexity 29 -- Token dispatch keeps the scanner's existing string and import paths together.
static bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[SENTINEL_ERROR]) {
        return false;
    }

    lexer->mark_end(lexer);

    if (valid_symbols[HEREDOC_LINE_START]) {
        lexer->result_symbol = HEREDOC_LINE_START;
        if (scanner->current > 0) {
            while (iswspace(lexer->lookahead) && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
                advance(lexer);
            }
            scanner->can_close = is_valid_name_char(lexer);
        }
        return true;
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
        lexer->result_symbol = HEREDOC_END;
        if (scanner->current == 0) {
            return false;
        }

        Heredoc heredoc = *current_heredoc(scanner);

        while (iswspace(lexer->lookahead)) {
            skip(lexer);
        }

        String word = scan_heredoc_word(lexer);
        if (!string_eq(&word, &heredoc.word)) {
            array_delete(&word);
            return false;
        }
        array_delete(&word);

        lexer->mark_end(lexer);
        scanner->current = heredoc.parent;
        scanner->can_close = heredoc.parent_can_close;
        return true;
    }

    PrefixScanResult prefix = scan_name_prefix(lexer, valid_symbols);
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
        lexer->result_symbol = HEREDOC_START;
        Heredoc heredoc = {
            .parent = scanner->current,
            .parent_can_close = scanner->can_close,
        };

        while (iswspace(lexer->lookahead)) {
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

    if (!valid_symbols[AUTOMATIC_SEMICOLON] || lexer->lookahead != '?') {
        return false;
    }
    lexer->result_symbol = AUTOMATIC_SEMICOLON;
    advance(lexer);
    return lexer->lookahead == '>';
}

static PrefixScanResult scan_name_prefix(TSLexer *lexer, const bool *valid_symbols) {
    if (valid_symbols[NAMESPACE_USE_SEPARATOR] || valid_symbols[NAMESPACE_USE_PREFIX]) {
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
    if (!valid_symbols[QUALIFIED_KEYWORD]) {
        return NoPrefix;
    }
    const char *keyword = qualified_keyword_start(lexer);
    if (!keyword) {
        return NoPrefix;
    }
    return scan_qualified_keyword(lexer, keyword) ? PrefixAccepted : PrefixRejected;
}

static bool scan_namespace_use_prefix(TSLexer *lexer) {
    const char relative_prefix[] = "namespace";
    size_t length = 0;
    bool relative = true;
    while (is_valid_name_char(lexer)) {
        if (length >= sizeof(relative_prefix) - 1 || towlower(lexer->lookahead) != relative_prefix[length]) {
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
    if (!scan_namespace_use_gap(lexer) || lexer->lookahead != '\\') {
        return false;
    }
    lexer->result_symbol = NAMESPACE_USE_SEPARATOR;
    return true;
}

static bool scan_namespace_use_gap(TSLexer *lexer) {
    for (;;) {
        while (is_php_whitespace(lexer->lookahead)) {
            advance(lexer);
        }
        if (lexer->lookahead != '/' && lexer->lookahead != '#') {
            return true;
        }
        if (!scan_namespace_use_comment(lexer)) {
            return false;
        }
    }
}

static bool scan_namespace_use_comment(TSLexer *lexer) {
    if (lexer->lookahead == '#') {
        advance(lexer);
        return scan_namespace_use_line_comment(lexer);
    }
    advance(lexer);
    if (lexer->lookahead == '/') {
        advance(lexer);
        return scan_namespace_use_line_comment(lexer);
    }
    if (lexer->lookahead != '*') {
        return false;
    }
    advance(lexer);
    return scan_namespace_use_block_comment(lexer);
}

static bool scan_namespace_use_line_comment(TSLexer *lexer) {
    while (lexer->lookahead != 0 && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
        if (lexer->lookahead == '?') {
            advance(lexer);
            if (lexer->lookahead == '>') {
                return false;
            }
        } else {
            advance(lexer);
        }
    }
    return true;
}

static bool scan_namespace_use_block_comment(TSLexer *lexer) {
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

static const char *qualified_keyword_start(TSLexer *lexer) {
    while (is_php_whitespace(lexer->lookahead)) {
        skip(lexer);
    }

    switch (lexer->lookahead) {
        case 'a':
        case 'A':
            return "array";
        case 'f':
        case 'F':
            return "function";
        case 'm':
        case 'M':
            return "match";
        default:
            return NULL;
    }
}

static bool scan_qualified_keyword(TSLexer *lexer, const char *word) {
    for (; *word; word++) {
        if (towlower(lexer->lookahead) != *word) {
            return false;
        }
        advance(lexer);
    }

    if (lexer->lookahead != '\\') {
        return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = QUALIFIED_KEYWORD;
    return true;
}

static inline void *external_scanner_create() {
    Scanner *scanner = ts_calloc(1, sizeof(Scanner));
    array_init(&scanner->heredocs);
    return scanner;
}

static inline unsigned external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    return serialize(scanner, buffer);
}

static inline void external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    deserialize(scanner, buffer, length);
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
