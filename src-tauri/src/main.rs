// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CLI 子命令: index / search / dump。
    // 只有一个二进制, 打包出来的 .app 里不会混进一堆可执行文件。
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");

    match sub {
        "index" => cc_reader_lib::cli::index(&args[1..]),
        "search" => cc_reader_lib::cli::search(&args[1..]),
        "dump" => cc_reader_lib::cli::dump(&args[1..]),
        _ => cc_reader_lib::run(),
    }
}
