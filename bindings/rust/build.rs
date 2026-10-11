fn main() {
    let mut c_config = cc::Build::new();
    // common/scanner.h includes tree_sitter/parser.h, which `tree-sitter generate` writes into each src/ alike.
    c_config.std("c11").include("php/src");

    #[cfg(target_env = "msvc")]
    c_config.flag("-utf-8");

    if std::env::var("TARGET").unwrap() == "wasm32-unknown-unknown" {
        let Ok(wasm_headers) = std::env::var("DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS") else {
            panic!(
                "Environment variable DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS must be set by the language crate"
            );
        };

        c_config.include(&wasm_headers);
    }

    for grammar in ["php", "php_only"] {
        let src_dir = std::path::Path::new(grammar).join("src");
        for name in ["parser.c", "scanner.c"] {
            let path = src_dir.join(name);
            c_config.file(&path);
            println!("cargo:rerun-if-changed={}", path.to_str().unwrap());
        }
    }
    // Both scanner.c files include the shared scanner.
    println!("cargo:rerun-if-changed=common/scanner.h");

    c_config.compile("tree-sitter-php");
}
